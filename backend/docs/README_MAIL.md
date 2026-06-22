# Email System

**Last Updated**: June 18, 2026

Scrapalot backend email system for transactional emails — invitations, Pro trial activation, and release notes.

## Architecture

```
UI (Settings → Users → Invite)
        ↓
AdminEmailController (REST)
        ↓
   EmailService (JavaMailSender)
        ↓
   EmailTemplates (Kotlin string templates → HTML)
        ↓
   Mailgun EU (smtp.eu.mailgun.org:587)
        ↓
   noreply@scrapalot.app → recipient inbox
```

No Thymeleaf or template engine — templates are external HTML resource files in `src/main/resources/email/` (loaded via `getResourceAsStream` and filled with simple `{{key}}` substitution by `EmailTemplates.kt`), with CSS inlined for maximum email client compatibility.

## Email Address Scheme (by purpose)

Only the **`mail.scrapalot.app`** subdomain receives mail (catch-all route → Gmail). Bare-root `@scrapalot.app` addresses have **no MX** and must never be used where a human might reply. Each purpose maps to one deliverable mailbox; all four are also wired as Gmail "Send mail as" identities (same SMTP credentials) so replies go out branded.

| Address | Purpose | Used in |
|---|---|---|
| `hello@mail.scrapalot.app` | General & public contact, user feedback, privacy/GDPR, account deletion, footer support; default **Reply-To** on all user-facing emails; email signature | UI contact/privacy/delete/footer/command-palette · `email.reply-to-address` · `layout.html` signature |
| `support@mail.scrapalot.app` | Technical support & API contact | OpenAPI/Swagger contact (backend + gateway) · contact page "Support" card |
| `contact@mail.scrapalot.app` | Sales / business / enterprise inquiries | pricing "Contact Sales" · footer "Enterprise Sales" |
| `research@mail.scrapalot.app` | Academic API registrations + polite-pool `User-Agent` contact | metadata / external-book providers (Kotlin `MetadataResolverService`, Python `metadata_resolver`/`scidb`/`wikipedia`/`bibtex`) · `ACADEMIC_CONTACT_EMAIL` default · contact page "Research" card · Google Play store contact |

**Reply-To**: `EmailService.sendHtml` sets a Reply-To header (`email.reply-to-address`, default `hello@mail.scrapalot.app`) on every outbound email, so a recipient replying to the `noreply@` From lands in a real inbox. The **contact-form notification** overrides it with the submitter's address (`replyTo = senderEmail`) so the operator answers the person directly.

## Production Setup (Current)

### Provider: Mailgun EU

- **Domain**: `mail.scrapalot.app` (EU region)
- **SMTP Host**: `smtp.eu.mailgun.org`
- **SMTP Port**: 587 (STARTTLS)
- **SMTP Username**: `postmaster@mail.scrapalot.app`
- **Sender Address**: `noreply@scrapalot.app`
- **Dashboard**: https://app.eu.mailgun.com/mg/sending/mail.scrapalot.app/settings

### DNS Records (GoDaddy → scrapalot.app)

All verified and active:

| Type | Host | Value | Status |
|------|------|-------|--------|
| TXT (SPF) | `mail` | `v=spf1 include:mailgun.org ~all` | Verified |
| TXT (DKIM) | `mta._domainkey.mail` | `k=rsa; p=MIGfMA0GCSqGSIb3DQ...` (1024-bit) | Active |
| MX | `mail` | `mxa.eu.mailgun.org` (priority 10) | Verified |
| MX | `mail` | `mxb.eu.mailgun.org` (priority 10) | Verified |
| CNAME | `email.mail` | `eu.mailgun.org` | Verified |

DNS managed via GoDaddy: https://dcc.godaddy.com/control/portfolio/scrapalot.app/settings

### Environment Variables

Stored in two places:
1. **`.env`** file: `/opt/scrapalot/scrapalot-chat/docker-scrapalot/.env` (runtime)
2. **GitHub Secrets**: `SMTP_USERNAME`, `SMTP_PASSWORD` (CI/CD deploys)

| Variable | Default | Description |
|----------|---------|-------------|
| `SMTP_HOST` | `smtp.eu.mailgun.org` | SMTP server hostname (EU region) |
| `SMTP_PORT` | `587` | SMTP port (STARTTLS) |
| `SMTP_USERNAME` | — | `postmaster@mail.scrapalot.app` |
| `SMTP_PASSWORD` | — | Mailgun SMTP password |
| `EMAIL_FROM` | `noreply@scrapalot.app` | Sender (From) email address |
| `EMAIL_FROM_NAME` | `Scrapalot AI` | Sender display name |
| `EMAIL_REPLY_TO` | `hello@mail.scrapalot.app` | Reply-To header on user-facing emails (contact-form notifications reply to the submitter instead) |
| `EMAIL_ENABLED` | `false` | `true` to send real emails, `false` to log only |
| `EMAIL_BASE_URL` | `https://scrapalot.app` | Base URL for links in emails |
| `EMAIL_CONTACT_NOTIFY` | `simun.sunjic@gmail.com` | Recipient for contact-form notifications |

These bind to the `email.*` block in `src/main/resources/application.yaml` (`email.from-address`, `email.from-name`, `email.reply-to-address`, `email.enabled`, `email.base-url`, `email.contact-notify-address`); SMTP itself uses `spring.mail.*`.

**Retrieve the live SMTP config (incl. password) from the running container** — e.g. to set up a Gmail "Send mail as" identity for one of the `@mail.scrapalot.app` addresses:

```bash
docker exec scrapalot-backend printenv | grep SMTP
# SMTP_HOST=smtp.eu.mailgun.org
# SMTP_PORT=587
# SMTP_USERNAME=postmaster@mail.scrapalot.app
# SMTP_PASSWORD=<secret — never commit this value>
```

The same `postmaster@mail.scrapalot.app` + SMTP password authorizes sending as **any** `@mail.scrapalot.app` address. A Gmail "Send mail as" entry for hello@/support@/contact@/research@ all use these **identical** settings (host `smtp.eu.mailgun.org`, port `587`, TLS). The confirmation code Gmail emails to each address is delivered back to the Gmail inbox via the catch-all route below.

### CI/CD Integration

GitHub Actions workflow (`deploy-backend.yml`) passes SMTP secrets to the deploy step:
```yaml
env:
  SMTP_USERNAME: ${{ secrets.SMTP_USERNAME }}
  SMTP_PASSWORD: ${{ secrets.SMTP_PASSWORD }}
```

Docker Compose (`docker-scrapalot/docker-compose.yaml`) maps env vars to the backend container:
```yaml
SMTP_HOST: ${SMTP_HOST:-smtp.eu.mailgun.org}
SMTP_PORT: ${SMTP_PORT:-587}
SMTP_USERNAME: ${SMTP_USERNAME:-}
SMTP_PASSWORD: ${SMTP_PASSWORD:-}
EMAIL_ENABLED: ${EMAIL_ENABLED:-false}
```

### Dev Mode

When `EMAIL_ENABLED=false` (default), `EmailService` logs the recipient and subject but does **not** send. Safe for local development.

## UI Integration

**Settings → Users → Invite** button opens a dialog where admins can enter email + name. Calls `POST /api/v1/admin/email/invitation` with the admin's JWT token.

Frontend files:
- `scrapalot-ui/src/components/settings/settings-tab-users.tsx` — Invite dialog
- Translation keys: `settings.users.invite.*` (en + hr)

## API Endpoints

All endpoints require **admin** role. Accessible via Gateway at `/api/v1/admin/email/*`.

### POST `/api/v1/admin/email/test`

Send a test email (uses invitation template).

```json
{ "email": "admin@example.com" }
```

### POST `/api/v1/admin/email/invitation`

Invite an unregistered user as a non-billable test user.

```json
{
  "email": "user@example.com",
  "recipient_name": "Jane Doe"
}
```

The admin's name is automatically used as the inviter. Template includes a "Non-Billable Test Account" badge and feature pills (Deep Research, Knowledge Graphs, AI Agents).

### POST `/api/v1/admin/email/pro-trial`

Send a 1-month Pro trial activation email.

```json
{
  "email": "user@example.com",
  "recipient_name": "Jane Doe"
}
```

Trial end date is auto-calculated (today + 1 month). Template includes a feature grid (Workspaces, Deep Research, Knowledge Graph, Team Sharing) and trial countdown.

### POST `/api/v1/admin/email/release-notes`

Send release notes to specific users or all active users.

```json
{
  "emails": ["user1@example.com", "user2@example.com"],
  "version": "2.4.0",
  "release_date": "March 12, 2026",
  "highlights": [
    { "emoji": "🔍", "title": "Deep Research v2", "description": "5-phase research with multi-agent orchestration" },
    { "emoji": "📊", "title": "Knowledge Graph", "description": "Neo4j-powered entity visualization" },
    { "emoji": "⚡", "title": "RAG Performance", "description": "6x faster retrieval with skip-reranking" }
  ]
}
```

Omit `emails` to send to **all active users**.

**Response** (all endpoints):
```json
{
  "success": true,
  "message": "Sent 3/3 release notes emails",
  "sent_count": 3
}
```

## Email Templates

Six content templates with a shared dark-theme layout (`layout.html`):

| Template | Header Gradient | Use Case |
|----------|----------------|----------|
| **Invitation** | Indigo → Violet | Invite unregistered test users (non-billable) |
| **Pro Trial** | Teal → Cyan | 1-month Pro trial activation |
| **Release Notes** | Orange → Amber | New version announcements |
| **Contact Notification** | — | Notify the team of inbound contact-form submissions |
| **Workspace Shared** | Blue → Light-blue | Notify a recipient that a workspace was shared with them (direct share) |
| **New User** | Blue → Light-blue | Notify the operator (`email.contact-notify-address`) that someone signed up |

**Workspace Shared** is sent best-effort from `WorkspaceController.shareWorkspace` after the access grant commits (a mail failure never fails the share). Its "Open Workspace" CTA is a deep-link — `/dashboard?workspace=<id>&view=library` — so the recipient lands on the shared workspace with the Knowledge Stacks library open (handled in the frontend `Index.tsx`).

**New User** is sent best-effort from `AuthService` on both email registration and first-time Google OAuth sign-up, to `email.contact-notify-address` (env `EMAIL_CONTACT_NOTIFY`, default `simun.sunjic@gmail.com`).

### Design

- **Dark theme** (`#0f172a` background, `#1e293b` card) matching Scrapalot UI
- **Gradient hero headers** with emoji icons
- **Scrapalot logo** from `https://scrapalot.app/providers/scrapalot.png`
- **Signature block** (in `layout.html`, above the footer) — logo, the "AI Research Assistant" tagline, and `hello@mail.scrapalot.app` + `scrapalot.app` links; rendered on every email
- **Table-based layout** for Outlook/Gmail/Yahoo compatibility
- **All CSS inlined** (no `<style>` blocks)
- **Max width 600px**, responsive via `width:100%`
- **Fallback text links** below every CTA button

## File Structure

```
src/main/kotlin/com/scrapalot/backend/
├── email/
│   └── EmailTemplates.kt          # Loads + fills external HTML resources ({{key}} substitution)
├── dto/
│   └── EmailDTOs.kt               # Request/response DTOs with validation
├── service/
│   └── EmailService.kt            # Core sending service (dev mode support)
└── controller/admin/
    └── AdminEmailController.kt    # Admin-only REST endpoints

src/main/resources/email/         # External HTML templates
├── layout.html                   # Shared dark-theme wrapper
├── invitation.html
├── pro-trial.html
├── release-notes.html
├── release-notes-highlight.html
├── contact-notification.html
└── contact-notification-company.html
```

## Testing

```bash
# Send test email (requires admin JWT)
curl -X POST https://api.scrapalot.app/api/v1/admin/email/test \
  -H "Authorization: Bearer <token>" \
  -H "Content-Type: application/json" \
  -d '{"email": "your@email.com"}'

# Check backend logs
docker logs scrapalot-backend | grep "\[Email\]"
# "[Email] Sent to=..." = actually sent
# "[Email] DISABLED — would send to=..." = dev mode (EMAIL_ENABLED=false)
```

## Mailgun API (Inbound Routing + Management)

Beyond SMTP sending, Mailgun provides an HTTP API for inbound email routing and domain management.

### API Access

- **API Base**: `https://api.eu.mailgun.net/v3` (EU region)
- **Auth**: `--user "api:$MAILGUN_API_KEY"`
- **Secret**: `MAILGUN_API_KEY` in GitHub secrets (`scrapalot-backend` repo + `scrapalot-chat` prod env)
- **Dashboard**: https://app.eu.mailgun.com

### Inbound Email Routing

MX records on `mail.scrapalot.app` point to Mailgun, enabling inbound email:

| Expression | Forwards To | Route ID | Purpose |
|---|---|---|---|
| `match_recipient(".*@mail\.scrapalot\.app")` (catch-all) | `simun.sunjic@gmail.com` | `69dbcba2f57efe2559f7b953` | **All** inbound on the subdomain — `hello@` (public support), `research@` (academic API regs), and anything else |

**Note**: Only the `mail.scrapalot.app` subdomain has MX records. Root `scrapalot.app` does NOT receive email. The Mailgun plan caps the account at **1 route + 1 domain**, so inbound is a single catch-all rather than per-address routes (a 2nd route returns `quota exceeded`).

### Public contact address: `hello@mail.scrapalot.app` (resolved June 2026)

`hello@scrapalot.app` (bare root) was published as the public support address but
was **undeliverable** — root `scrapalot.app` has no MX records, and adding them
would need a 2nd Mailgun domain (blocked by the 1-domain plan cap). Resolved by
using **`hello@mail.scrapalot.app`** instead, which the catch-all route above
already forwards to Gmail. The general UI contact links (contact, privacy,
delete-account, footer, command palette) use `hello@mail.scrapalot.app`;
sales/enterprise links use `contact@mail.scrapalot.app` and research links use
`research@mail.scrapalot.app` (see **Email Address Scheme** at the top — all on
the `mail.` subdomain, never bare root).

To enable the *bare* `hello@scrapalot.app` later would require a Mailgun plan
upgrade (root domain + 2nd route) plus root MX records in GoDaddy — not worth it;
prefer the `mail.` subdomain.

**Outbound auth / deliverability**: `mail.scrapalot.app` has valid SPF + DKIM
(selector `mta`). A DMARC record on the root enforces policy:
`_dmarc.scrapalot.app` TXT `v=DMARC1; p=quarantine; rua=mailto:hello@mail.scrapalot.app; adkim=r; aspf=r`.
Relaxed alignment passes because `From: noreply@scrapalot.app` shares the
organizational domain with the `mail.` subdomain.

**Policy progression** (`p=none` → `quarantine` → `reject`): started at `p=none`
to observe via aggregate reports, which confirmed **100% DKIM+SPF pass** for both
`header_from: scrapalot.app` (the `noreply@` sender, via relaxed alignment) and
`header_from: mail.scrapalot.app`. Raised to **`p=quarantine`** on 2026-06-18 in
GoDaddy. Optional next step is `p=reject` for maximum anti-spoofing.

**`rua` vs `p` are independent**: `p=` is the enforcement (what receivers do with
mail that fails auth); `rua=` is only the reporting channel. Google et al. send a
daily aggregate XML report to `hello@mail.scrapalot.app` (catch-all → Gmail) for
as long as `rua=` is present. Removing `rua=` stops the reports but does **not**
weaken protection — the `p=` policy still applies. (Tip: filter these XML reports
to a Gmail label, or repoint `rua=` to a free DMARC dashboard like dmarcian /
Postmark, instead of reading raw XML.)

BIMI (Gmail sender avatar) is not configured — it needs DMARC enforcement
(now satisfied at `quarantine`) **plus** a paid VMC certificate.

### Managing Routes

```bash
# List routes
curl -s --user "api:$MAILGUN_API_KEY" \
  "https://api.eu.mailgun.net/v3/routes" | python3 -m json.tool

# Create new route
curl -s --user "api:$MAILGUN_API_KEY" \
  "https://api.eu.mailgun.net/v3/routes" \
  -F priority=0 \
  -F description="Forward support@ to Gmail" \
  -F 'expression=match_recipient("support@mail.scrapalot.app")' \
  -F 'action=forward("simun.sunjic@gmail.com")' \
  -F 'action=stop()'

# Delete route
curl -s --user "api:$MAILGUN_API_KEY" \
  -X DELETE "https://api.eu.mailgun.net/v3/routes/<route_id>"
```

## Academic API Keys

API keys for academic database integrations (Feature 1 from scientific_skills PRD). Stored in GitHub secrets under `scrapalot-chat` prod environment.

| Secret | Service | Papers | Registration Email |
|---|---|---|---|
| `OPENALEX_API_KEY` | [OpenAlex](https://openalex.org) | 250M works | — |
| `NCBI_API_KEY` | [PubMed/NCBI](https://www.ncbi.nlm.nih.gov/account/settings/) | 36M biomedical | — |
| `S2_API_KEY` | [Semantic Scholar](https://www.semanticscholar.org/product/api) | 200M papers + citation graphs | `research@mail.scrapalot.app` |

Configuration in Python: `scrapalot-chat/configs/config.yaml` under `academic_search` section references these keys via `ACADEMIC_CONTACT_EMAIL`, `OPENALEX_API_KEY`, `S2_API_KEY`, `NCBI_API_KEY`.

## Troubleshooting

| Symptom | Cause | Fix |
|---------|-------|-----|
| `[Email] DISABLED` in logs | `EMAIL_ENABLED=false` | Set `EMAIL_ENABLED=true` in `.env`, recreate container |
| `AuthenticationFailedException: no password specified` | SMTP credentials not in container env | Check `.env` has `SMTP_USERNAME`/`SMTP_PASSWORD`, recreate container |
| API returns `success:true` but no email arrives | Dev mode — service logs instead of sending | Verify `EMAIL_ENABLED=true` via `docker exec scrapalot-backend printenv EMAIL_ENABLED` |
| Email in spam folder | Missing DNS records | Verify all 5 DNS records in Mailgun dashboard (Check status) |
| CI/CD deploy loses SMTP config | GitHub secrets not passed to deploy step | Ensure `SMTP_USERNAME`/`SMTP_PASSWORD` in `deploy-backend.yml` env block |
