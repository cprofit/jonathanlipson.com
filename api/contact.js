// POST /api/contact
const nodemailer = require("nodemailer");
const https = require("https");

module.exports = async function handler(req, res) {
  // CORS + preflight
  if (req.method === "OPTIONS") {
    cors(res);
    return res.status(204).end();
  }
  if (req.method !== "POST") return res.status(405).send("Method not allowed");

  // Read raw body with a hard cap
  const raw = await readBody(req, 120 * 1024);
  const ct = String(req.headers["content-type"] || "").toLowerCase();
  let data = {};
  try {
    if (ct.includes("application/x-www-form-urlencoded")) {
      const p = new URLSearchParams(raw);
      data = Object.fromEntries(p.entries());
    } else if (ct.includes("application/json")) {
      data = JSON.parse(raw || "{}");
    } else return res.status(415).send("Unsupported content type");
  } catch {
    return res.status(400).send("Bad body");
  }

  // Honeypot
  if (data._honey) return ok(res);

  // Validate
  const name = clip(String(data.name || "").trim(), 120);
  const email = clip(String(data.email || "").trim(), 180);
  const message = clip(String(data.message || "").trim(), 5000);
  if (!name || !email || !message) return res.status(400).send("Missing fields");
  if (!/^[^@]+@[^@]+\.[^@]+$/.test(email)) return res.status(400).send("Invalid email");

  // Turnstile (optional but recommended)
  if (process.env.TURNSTILE_SECRET) {
    const token = String(data["cf-turnstile-response"] || "");
    if (!token) return res.status(400).send("Captcha missing");
    const okCaptcha = await verifyTurnstile(token, req);
    if (!okCaptcha) return res.status(400).send("Captcha failed");
  }

  // Basic content checks
  const linkCount = (message.match(/https?:\/\//gi) || []).length;
  if (linkCount > 5) return ok(res); // drop silently
  if (/viagra|escort|forex|crypto|porn|loan|investment/i.test(message)) return ok(res);

  // Send via Zoho SMTP
  try {
    const transporter = nodemailer.createTransport({
      host: "smtp.zoho.com",
      port: 465,
      secure: true,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });

    const html = `
      <div style="font-family:Inter,Arial,sans-serif">
        <h3>New inquiry</h3>
        <p><strong>Name:</strong> ${escapeHtml(name)}</p>
        <p><strong>Email:</strong> ${escapeHtml(email)}</p>
        <p><strong>Message:</strong></p>
        <pre style="white-space:pre-wrap">${escapeHtml(message)}</pre>
      </div>`;

    await transporter.sendMail({
      from: process.env.FROM_EMAIL || process.env.SMTP_USER,
      to: process.env.DEST_EMAIL || process.env.SMTP_USER,
      replyTo: `${name} <${email}>`,
      subject: `Website inquiry from ${name}`,
      html
    });
  } catch {
    return res.status(502).send("Mail error");
  }

  const allow = new Set([process.env.ALLOWED_ORIGIN || "https://www.jonathanlipson.com"]);
  const redirect = String(data._redirect || "");
  if (redirect && [...allow].some(a => redirect.startsWith(a + "/"))) {
    res.setHeader("Location", redirect);
    return res.status(303).end();
  }
  return ok(res);
};

// helpers
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "https://www.jonathanlipson.com");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
}
function ok(res) { cors(res); return res.status(200).send("OK"); }
function clip(v, n) { return v.slice(0, n); }
function escapeHtml(s){return s.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c]));}
function readBody(req, max){
  return new Promise(resolve=>{
    let buf = "";
    req.on("data", chunk => { buf += chunk; if (buf.length > max) buf = buf.slice(0, max); });
    req.on("end", () => resolve(buf));
  });
}
async function verifyTurnstile(token, req) {
  const params = new URLSearchParams({
    secret: process.env.TURNSTILE_SECRET,
    response: token,
    remoteip: String(req.headers["x-forwarded-for"] || "").split(",")[0] || ""
  }).toString();

  return new Promise(resolve => {
    const r = https.request(
      {
        hostname: "challenges.cloudflare.com",
        path: "/turnstile/v0/siteverify",
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", "content-length": Buffer.byteLength(params) }
      },
      resp => {
        let data = "";
        resp.on("data", d => data += d);
        resp.on("end", () => {
          try { resolve(JSON.parse(data).success === true); }
          catch { resolve(false); }
        });
      }
    );
    r.on("error", () => resolve(false));
    r.write(params);
    r.end();
  });
}
