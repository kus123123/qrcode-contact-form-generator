# QR Contact Locker

Create contact pages from an admin screen and generate QR codes that open them.

The app now stores contacts in Postgres, so it is suitable for server deployment.

## Flow

1. Open `/admin.html`
2. Create a contact
3. Share the generated QR code
4. The first scan opens an editable form
5. After that person clicks `Save and Lock`, the contact page becomes read-only for everyone

## Run

```bash
cp .env.example .env
pnpm install
pnpm start
```

Then open `http://localhost:3000/admin.html`.

## Environment

`DATABASE_URL` is required.

Example:

```bash
DATABASE_URL=postgres://postgres:password@localhost:5432/qr_contact_app
```

## Docker Deploy

Use [docker-compose.deploy.yml](/Users/kushagra/Documents/qrcode%20scanner/docker-compose.deploy.yml) on the server.

By default it maps the app to `3001`, so it can run beside your existing service on `3000`.
