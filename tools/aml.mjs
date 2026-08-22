/** AML grezzo, risposta XML non filtrata. Uso: node tools/aml.mjs '<Item .../>' */
const URL_BASE = "http://localhost/InnovatorServer";
const DB = "InnovatorSolutions";
export async function token(user = process.env.ARAS_USER, pass = process.env.ARAS_PASSWORD) {
  const r = await fetch(`${URL_BASE}/oauthserver/connect/token`, {
    method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "password", client_id: "IOMApp", scope: "Innovator", database: DB, username: user, password: pass }),
  });
  if (!r.ok) throw new Error("token: " + r.status + " " + (await r.text()).slice(0, 200));
  return (await r.json()).access_token;
}
export async function aml(xml, tk) {
  const t = tk ?? (await token());
  const env = `<?xml version="1.0" encoding="utf-8"?><SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/"><SOAP-ENV:Body><ApplyItem>${xml}</ApplyItem></SOAP-ENV:Body></SOAP-ENV:Envelope>`;
  const r = await fetch(`${URL_BASE}/Server/InnovatorServer.aspx`, {
    method: "POST",
    headers: { "Content-Type": "text/xml; charset=utf-8", SOAPAction: "ApplyItem", Authorization: `Bearer ${t}`, DATABASE: DB },
    body: env,
  });
  return await r.text();
}
if (process.argv[2]) {
  const out = await aml(process.argv[2]);
  console.log(out.split("><").join(">\n<"));
}
