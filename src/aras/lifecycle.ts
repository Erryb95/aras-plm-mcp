import { ArasClient } from "./client.js";
import { AmlClient } from "./aml.js";

export interface Transizione {
  da: string;
  a: string;
  ruoloRichiesto: string | null;
}

export interface MappaCicloVita {
  nome: string;
  stati: string[];
  transizioni: Transizione[];
}

/**
 * Grafo del ciclo di vita: stati e transizioni, ciascuna con il ruolo richiesto.
 *
 * Va letto via AML con le Relationships annidate. In OData la query su
 * "Life Cycle State"/"Life Cycle Transition" filtrata per source_id risponde 400,
 * essendo riferimenti polimorfi.
 */
export async function mappaCicloVita(aml: AmlClient, nomeMappa: string): Promise<MappaCicloVita | null> {
  const xml = (await aml.apply(
    `<Item type="Life Cycle Map" action="get" select="name"><name>${nomeMappa}</name>` +
    `<Relationships>` +
    `<Item type="Life Cycle State" action="get" select="name"/>` +
    `<Item type="Life Cycle Transition" action="get" select="from_state,to_state,role"/>` +
    `</Relationships></Item>`
  )).raw;

  if (!/<Item[^>]*type="Life Cycle Map"/.test(xml)) return null;

  const stati = [...xml.matchAll(/<Item[^>]*type="Life Cycle State"[^>]*>[\s\S]*?<name>([^<]*)<\/name>/g)]
    .map((m) => m[1]!).filter((v, i, a) => a.indexOf(v) === i);

  const transizioni: Transizione[] = [];
  for (const blocco of xml.matchAll(/<Item[^>]*type="Life Cycle Transition"[^>]*>([\s\S]*?)<\/Item>/g)) {
    const b = blocco[1]!;
    const da = /<from_state[^>]*keyed_name="([^"]*)"/.exec(b)?.[1];
    const a = /<to_state[^>]*keyed_name="([^"]*)"/.exec(b)?.[1];
    if (!da || !a) continue;
    transizioni.push({ da, a, ruoloRichiesto: /<role[^>]*keyed_name="([^"]*)"/.exec(b)?.[1] ?? null });
  }

  return { nome: nomeMappa, stati, transizioni };
}

/**
 * Stati verso cui l'utente corrente puo' realmente promuovere.
 *
 * `getItemNextStates` restituisce SOLO le transizioni disponibili a chi chiama: se
 * l'utente non possiede il ruolo indicato sulla transizione, la risposta e' un
 * `<Result />` vuoto e `promoteItem` fallisce con "failed to get the transition",
 * un messaggio che sembra indicare una transizione inesistente mentre il problema
 * e' di autorizzazione. Verificato: aggiungendo l'utente all'identita' richiesta
 * (es. "Aras PLM") gli stessi stati compaiono e la promozione riesce.
 */
export async function statiDisponibili(aml: AmlClient, itemType: string, id: string): Promise<string[]> {
  const xml = (await aml.apply(`<Item type="${itemType}" id="${id}" action="getItemNextStates"/>`)).raw;
  return [...xml.matchAll(/<Item[^>]*type="Life Cycle State"[^>]*>[\s\S]*?<name>([^<]*)<\/name>/g)]
    .map((m) => m[1]!)
    .filter((v, i, a) => a.indexOf(v) === i);
}

/** Identita' possedute dall'utente corrente, incluse quelle ereditate per appartenenza. */
export async function identitaCorrenti(client: ArasClient): Promise<string[]> {
  const me = await client.query<Record<string, unknown>>("User", {
    filter: `login_name eq '${client.cfg.username}'`,
    select: ["id", "first_name", "last_name"],
    top: 1,
  });
  const u = me.value[0];
  if (!u) return [];
  const nome = `${u["first_name"] ?? ""} ${u["last_name"] ?? ""}`.trim();

  const alias = await client.query<Record<string, unknown>>("Identity", {
    filter: `name eq '${nome.replace(/'/g, "''")}'`, select: ["id", "name"], top: 1,
  });
  const aliasId = alias.value[0]?.["id"] as string | undefined;
  if (!aliasId) return nome ? [nome] : [];

  // I gruppi si raggiungono risalendo le righe Member in cui l'identita' e' il membro.
  const gruppi = await client.queryAll<Record<string, unknown>>("Member", {
    select: ["source_id", "related_id"], top: 500,
  }, 2000);

  const appartenenze = gruppi.value
    .filter((m) => (m["related_id@aras.id"] as string) === aliasId)
    .map((m) => m["source_id@aras.keyed_name"] as string)
    .filter(Boolean);

  return [nome, ...appartenenze];
}

export interface PianoRilascio {
  statoAttuale: string;
  statoTarget: string;
  percorso: string[];
  eseguibile: boolean;
  bloccoSu?: { da: string; a: string; ruoloRichiesto: string | null };
  motivo?: string;
}

/**
 * Calcola il percorso di stati per arrivare al target, sul grafo delle transizioni.
 * Ricerca in ampiezza: il percorso piu' corto e' quello che si vuole quasi sempre.
 */
export function percorso(mappa: MappaCicloVita, da: string, a: string): string[] | null {
  if (da === a) return [da];
  const coda: string[][] = [[da]];
  const visti = new Set([da]);
  while (coda.length) {
    const p = coda.shift()!;
    const ultimo = p[p.length - 1]!;
    for (const t of mappa.transizioni.filter((x) => x.da === ultimo)) {
      if (visti.has(t.a)) continue;
      const nuovo = [...p, t.a];
      if (t.a === a) return nuovo;
      visti.add(t.a);
      coda.push(nuovo);
    }
  }
  return null;
}
