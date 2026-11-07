# FivePA / WorkPerHour

A full-stack freelance marketplace with escrow payment protection, real-time WorkStream collaboration, Gigs, and Projects.

## Run Locally

**Prerequisites:** Node.js (v20+)

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy `.env.example` to `.env` (or `.env.local`) and configure the required environment variables:
   - `JWT_SECRET`: Minimum 32 characters in production (minimum 16 characters in development).
   - `GATEWAY_ENCRYPTION_KEY`: Minimum 16 characters, distinct from `JWT_SECRET`.
   - `DATABASE_URL`: PostgreSQL connection string for production (falls back to embedded PGlite in local development).
   - `RESEND_API_KEY` & `EMAIL_FROM`: For transactional email delivery via Resend.
3. Start the development server on port 3000:
   ```bash
   npm run dev
   ```
4. Build for production:
   ```bash
   npm run build
   npm start
   ```
