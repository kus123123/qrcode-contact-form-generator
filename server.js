require("dotenv").config();

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");
const QRCode = require("qrcode");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "127.0.0.1";
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  throw new Error("DATABASE_URL is required.");
}

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.DATABASE_SSLMODE === "require" ? { rejectUnauthorized: false } : false
});

async function initializeDatabase() {
  await pool.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
  await pool.query(`
    CREATE TABLE IF NOT EXISTS contacts (
      id uuid PRIMARY KEY,
      full_name text NOT NULL,
      phone text NOT NULL DEFAULT '',
      email text NOT NULL DEFAULT '',
      company text NOT NULL DEFAULT '',
      title text NOT NULL DEFAULT '',
      website text NOT NULL DEFAULT '',
      address text NOT NULL DEFAULT '',
      notes text NOT NULL DEFAULT '',
      locked boolean NOT NULL DEFAULT false,
      first_opened_at timestamptz,
      edit_token uuid,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

function mapRow(row) {
  return {
    id: row.id,
    fullName: row.full_name,
    phone: row.phone,
    email: row.email,
    company: row.company,
    title: row.title,
    website: row.website,
    address: row.address,
    notes: row.notes,
    locked: row.locked,
    firstOpenedAt: row.first_opened_at ? new Date(row.first_opened_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

function buildPublicUrl(req, id) {
  return `${req.protocol}://${req.get("host")}/c/${id}`;
}

function sanitizeContactPayload(payload) {
  return {
    fullName: String(payload.fullName || "").trim(),
    phone: String(payload.phone || "").trim(),
    email: String(payload.email || "").trim(),
    company: String(payload.company || "").trim(),
    title: String(payload.title || "").trim(),
    website: String(payload.website || "").trim(),
    address: String(payload.address || "").trim(),
    notes: String(payload.notes || "").trim()
  };
}

async function withQr(req, contact) {
  const publicUrl = buildPublicUrl(req, contact.id);
  return {
    ...contact,
    publicUrl,
    qrCodeDataUrl: await QRCode.toDataURL(publicUrl)
  };
}

function escapeVCardValue(value) {
  return String(value || "")
    .replaceAll("\\", "\\\\")
    .replaceAll("\n", "\\n")
    .replaceAll(";", "\\;")
    .replaceAll(",", "\\,");
}

function buildVCard(contact) {
  return [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `FN:${escapeVCardValue(contact.fullName)}`,
    `ORG:${escapeVCardValue(contact.company)}`,
    `TITLE:${escapeVCardValue(contact.title)}`,
    `TEL;TYPE=CELL:${escapeVCardValue(contact.phone)}`,
    `EMAIL:${escapeVCardValue(contact.email)}`,
    `URL:${escapeVCardValue(contact.website)}`,
    `ADR:;;${escapeVCardValue(contact.address)};;;;`,
    `NOTE:${escapeVCardValue(contact.notes)}`,
    "END:VCARD"
  ].join("\n");
}

async function getContactById(id) {
  const result = await pool.query("SELECT * FROM contacts WHERE id = $1", [id]);
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/", (req, res) => {
  res.redirect("/admin.html");
});

app.get("/health", async (req, res) => {
  await pool.query("SELECT 1");
  res.json({ ok: true });
});

app.get("/c/:id", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "contact.html"));
});

app.get("/api/contacts", async (req, res, next) => {
  try {
    const result = await pool.query("SELECT * FROM contacts ORDER BY created_at DESC");
    const enriched = await Promise.all(result.rows.map((row) => withQr(req, mapRow(row))));
    res.json(enriched);
  } catch (error) {
    next(error);
  }
});

app.get("/api/contacts/:id", async (req, res, next) => {
  try {
    const contact = await getContactById(req.params.id);

    if (!contact) {
      return res.status(404).json({ error: "Contact not found." });
    }

    res.json(await withQr(req, contact));
  } catch (error) {
    next(error);
  }
});

app.post("/api/contacts", async (req, res, next) => {
  try {
    const payload = sanitizeContactPayload(req.body);

    if (!payload.fullName) {
      return res.status(400).json({ error: "Full name is required." });
    }

    const id = crypto.randomUUID();
    const result = await pool.query(
      `INSERT INTO contacts (
        id, full_name, phone, email, company, title, website, address, notes
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      RETURNING *`,
      [
        id,
        payload.fullName,
        payload.phone,
        payload.email,
        payload.company,
        payload.title,
        payload.website,
        payload.address,
        payload.notes
      ]
    );

    res.status(201).json(await withQr(req, mapRow(result.rows[0])));
  } catch (error) {
    next(error);
  }
});

app.put("/api/contacts/:id/admin", async (req, res, next) => {
  try {
    const payload = sanitizeContactPayload(req.body);
    const result = await pool.query(
      `UPDATE contacts
       SET full_name = $2,
           phone = $3,
           email = $4,
           company = $5,
           title = $6,
           website = $7,
           address = $8,
           notes = $9,
           updated_at = now()
       WHERE id = $1
       RETURNING *`,
      [
        req.params.id,
        payload.fullName,
        payload.phone,
        payload.email,
        payload.company,
        payload.title,
        payload.website,
        payload.address,
        payload.notes
      ]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: "Contact not found." });
    }

    res.json(await withQr(req, mapRow(result.rows[0])));
  } catch (error) {
    next(error);
  }
});

app.post("/api/contacts/:id/first-open", async (req, res, next) => {
  try {
    const result = await pool.query(
      `UPDATE contacts
       SET first_opened_at = COALESCE(first_opened_at, now()),
           edit_token = COALESCE(edit_token, gen_random_uuid()),
           updated_at = CASE WHEN first_opened_at IS NULL THEN now() ELSE updated_at END
       WHERE id = $1 AND locked = false AND first_opened_at IS NULL
       RETURNING locked, edit_token`,
      [req.params.id]
    );

    if (result.rows[0]) {
      return res.json({
        granted: true,
        editToken: result.rows[0].edit_token
      });
    }

    const contact = await getContactById(req.params.id);

    if (!contact) {
      return res.status(404).json({ error: "Contact not found." });
    }

    if (contact.locked) {
      return res.json({ granted: false, locked: true });
    }

    res.json({ granted: false, locked: false });
  } catch (error) {
    next(error);
  }
});

app.post("/api/contacts/:id/lock", async (req, res, next) => {
  try {
    const payload = sanitizeContactPayload(req.body);

    const result = await pool.query(
      `UPDATE contacts
       SET full_name = $2,
           phone = $3,
           email = $4,
           company = $5,
           title = $6,
           website = $7,
           address = $8,
           notes = $9,
           locked = true,
           edit_token = NULL,
           first_opened_at = COALESCE(first_opened_at, now()),
           updated_at = now()
       WHERE id = $1 AND locked = false AND edit_token = $10
       RETURNING *`,
      [
        req.params.id,
        payload.fullName,
        payload.phone,
        payload.email,
        payload.company,
        payload.title,
        payload.website,
        payload.address,
        payload.notes,
        req.body.editToken || ""
      ]
    );

    if (result.rows[0]) {
      return res.json(await withQr(req, mapRow(result.rows[0])));
    }

    const contact = await getContactById(req.params.id);

    if (!contact) {
      return res.status(404).json({ error: "Contact not found." });
    }

    if (contact.locked) {
      return res.status(409).json({ error: "This contact is already locked." });
    }

    res.status(403).json({ error: "Only the first scan can lock this contact." });
  } catch (error) {
    next(error);
  }
});

app.get("/api/contacts/:id/vcard", async (req, res, next) => {
  try {
    const contact = await getContactById(req.params.id);

    if (!contact) {
      return res.status(404).send("Contact not found.");
    }

    res.setHeader("Content-Type", "text/vcard; charset=utf-8");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${contact.fullName.replace(/[^a-z0-9]+/gi, "-").toLowerCase() || "contact"}.vcf"`
    );
    res.send(buildVCard(contact));
  } catch (error) {
    next(error);
  }
});

app.use((error, req, res, next) => {
  console.error(error);
  res.status(500).json({ error: "Internal server error." });
});

initializeDatabase()
  .then(() => {
    app.listen(PORT, HOST, () => {
      console.log(`QR contact app running on http://${HOST}:${PORT}`);
    });
  })
  .catch((error) => {
    console.error("Failed to start application:", error);
    process.exit(1);
  });
