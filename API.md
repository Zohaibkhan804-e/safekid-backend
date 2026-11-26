# SafeKid Backend API (v1)

Single Node.js/Express backend with PostgreSQL. This document is the contract between the backend, the **React parent portal** and the **Android child app**.

> **Rule:** nobody renames a field or changes a response shape without telling the group first. Add a line to the Changelog at the bottom.

## 1. Basics

| Item | Value |
|---|---|
| Base URL (local) | `http://localhost:3000/api/v1` |
| Base URL (Android emulator) | `http://10.0.2.2:3000/api/v1` |
| Base URL (real phone, same Wi-Fi) | `http://<PC IPv4>:3000/api/v1` |
| Base URL (deployed) | `TBD` (will be sent after deployment) |
| Health check | `GET http://localhost:3000/health` (no `/api/v1` prefix) |
| Format | JSON in, JSON out |
| Required header on requests with a body | `Content-Type: application/json` |
| Auth header | `Authorization: Bearer <token>` |

Keep the base URL in **one config place** in each client; it will change when the backend is deployed.

### Two kinds of tokens

| Token | Who gets it | Lifetime | Used on |
|---|---|---|---|
| **Parent token** | Parent portal, from register/login | 7 days | Routes under `/auth` (login), `/devices/...` |
| **Device token** | Child phone, from `POST /devices/pair` | 30 days | Routes under `/device/...` (no "s") |

Using the wrong token type returns `403 WRONG_ROLE`.

> **Careful with the URLs:** `/devices/...` (with an "s") is for the **parent**. `/device/...` (no "s") is for the **child phone**. Exception: `POST /devices/pair` is public (the phone has no token yet).

### Error format

Every error looks like this:

```json
{ "error": { "code": "INVALID_CODE", "message": "Code is invalid, expired or already used" } }
```

| HTTP | `code` | Meaning |
|---|---|---|
| 400 | `VALIDATION` | Body or query is malformed |
| 400 | `INVALID_CODE` | Pairing code is wrong, expired or already used |
| 400 | `NO_POLICY` | Ack sent but no policy exists for the device |
| 401 | `NO_TOKEN` | Missing `Authorization: Bearer` header |
| 401 | `BAD_TOKEN` | Token invalid or expired |
| 401 | `BAD_CREDENTIALS` | Wrong email or password |
| 401 | `DEVICE_REVOKED` | Device was removed; it must pair again |
| 403 | `WRONG_ROLE` | Parent token used on a device route, or the reverse |
| 404 | `DEVICE_NOT_FOUND` | Device does not exist or belongs to another parent |
| 404 | `NOT_FOUND` | Unknown route |
| 409 | `EMAIL_TAKEN` | Email already registered |
| 409 | `STALE_VERSION` | Ack was for an old policy version |
| 429 | `RATE_LIMIT` | Too many pairing attempts (20 per 15 minutes) |
| 500 | `INTERNAL` | Server error |

---

## 2. Endpoint summary

| # | Method | Path | Who | Purpose |
|---|---|---|---|---|
| 1 | POST | `/auth/register` | Portal | Create parent account |
| 2 | POST | `/auth/login` | Portal | Log in |
| 3 | POST | `/devices/pairing-codes` | Portal | Generate 6-digit pairing code |
| 4 | POST | `/devices/pair` | **App** | Redeem code, become a paired device |
| 5 | GET | `/devices` | Portal | List my paired devices |
| 6 | PUT | `/devices/:id/policy` | Portal | Save a new policy version |
| 7 | GET | `/devices/:id/policy` | Portal | Read latest policy |
| 8 | GET | `/devices/:id/policy-status` | Portal | pending / applied / unsupported / failed |
| 9 | GET | `/device/policy?currentVersion=N` | **App** | Fetch newer policy, if any |
| 10 | POST | `/device/policy/ack` | **App** | Report what the phone did with a version |
| 11 | POST | `/device/usage` | **App** | Upload app-usage events |
| 12 | GET | `/devices/:id/usage` | Portal | Raw usage list |
| 13 | GET | `/devices/:id/usage/summary` | Portal | Total time per app |

---

## 3. Authentication (Portal)

### 3.1 Register
`POST /auth/register`

```json
{ "email": "parent@test.com", "password": "password123" }
```
Password minimum 8 characters.

**201**
```json
{ "token": "eyJhbGciOi..." }
```
Errors: `400 VALIDATION`, `409 EMAIL_TAKEN`.

### 3.2 Login
`POST /auth/login`

```json
{ "email": "parent@test.com", "password": "password123" }
```

**200**
```json
{ "token": "eyJhbGciOi..." }
```
Errors: `400 VALIDATION`, `401 BAD_CREDENTIALS`.

---

## 4. Pairing

### 4.1 Generate pairing code (Portal)
`POST /devices/pairing-codes`  
Auth: **parent token**. No body.

**201**
```json
{ "code": "483920", "expiresAt": "2026-11-27T10:10:00.000Z" }
```
The code is valid for **10 minutes** and works **once**. Show it to the parent in large text.

### 4.2 Pair the phone (App)
`POST /devices/pair`  
Auth: **none** (the phone has no token yet).

```json
{
  "code": "483920",
  "deviceName": "Ali's Phone",
  "model": "Pixel 6",
  "fcmToken": "optional-firebase-token"
}
```
- `code`: exactly 6 digits, as a **string**
- `deviceName`: required, up to 100 characters
- `model`, `fcmToken`: optional

**201**
```json
{ "deviceId": "b1a7...-uuid", "token": "eyJhbGciOi..." }
```
**The app must save `token` and `deviceId` securely** and send the token on every later request.

Errors: `400 VALIDATION`, `400 INVALID_CODE`, `429 RATE_LIMIT`.

### 4.3 List devices (Portal)
`GET /devices`  
Auth: **parent token**.

**200**
```json
[
  {
    "id": "b1a7...-uuid",
    "name": "Ali's Phone",
    "model": "Pixel 6",
    "status": "active",
    "pairedAt": "2026-11-27T10:02:00.000Z",
    "lastSeenAt": "2026-11-27T10:05:00.000Z"
  }
]
```
`lastSeenAt` is `null` until the phone first calls a `/device/...` route, and it updates on every such call.

---

## 5. Policy

A policy is a **versioned** list of rules per device. Every save creates a new version (1, 2, 3...). Old versions are never edited.

### 5.1 Policy format

```json
{
  "schemaVersion": 1,
  "rules": [
    { "type": "app_block", "package": "com.google.android.youtube", "mode": "block" }
  ]
}
```

| Rule `type` | Fields | Notes |
|---|---|---|
| `app_block` | `package` (string), `mode` = `"block"` | **Used for the 30% demo** (YouTube app) |
| `domain_block` | `domains` (array of strings, 1-100) | Accepted and stored; enforcement is later, feasibility-dependent |

`schemaVersion` must be the number `1`. Unknown rule types are rejected with `400 VALIDATION`.

### 5.2 Save a policy (Portal)
`PUT /devices/:id/policy`  
Auth: **parent token**. Body: the policy above.

**201**
```json
{ "version": 2 }
```
Errors: `400 VALIDATION`, `404 DEVICE_NOT_FOUND`.

### 5.3 Read latest policy (Portal)
`GET /devices/:id/policy`  
Auth: **parent token**.

**200**
```json
{
  "version": 2,
  "rules": {
    "schemaVersion": 1,
    "rules": [ { "type": "app_block", "package": "com.google.android.youtube", "mode": "block" } ]
  },
  "createdAt": "2026-11-27T10:20:00.000Z"
}
```
Note: on this **portal** route, `rules` is the whole policy object (with its own inner `rules` array). If no policy exists yet: `{ "version": 0, "rules": null }`.

### 5.4 Policy status (Portal)
`GET /devices/:id/policy-status`  
Auth: **parent token**. Poll this every few seconds on the policy screen.

**200**
```json
{
  "latestVersion": 2,
  "status": "applied",
  "lastAck": {
    "version": 2,
    "status": "applied",
    "detail": null,
    "ackedAt": "2026-11-27T10:21:00.000Z"
  }
}
```

| `status` | Meaning | Suggested UI |
|---|---|---|
| `no_policy` | Parent never saved a policy | "No rules yet" |
| `pending` | Latest version saved, phone has not acknowledged it | "Waiting for device..." |
| `applied` | Phone confirmed it enforces the rules | Green tick |
| `unsupported` | Phone cannot enforce this rule | Warning with `lastAck.detail` |
| `failed` | Phone tried and failed | Error with `lastAck.detail` |

When the parent saves a new version, the status goes back to `pending` until the phone acknowledges **that** version.

### 5.5 Fetch policy (App)
`GET /device/policy?currentVersion=N`  
Auth: **device token**. `N` is the version the phone already has (use `0` if none).

**200, phone is already up to date**
```json
{ "upToDate": true, "version": 2 }
```

**200, a newer version exists**
```json
{
  "upToDate": false,
  "version": 2,
  "schemaVersion": 1,
  "rules": [
    { "type": "app_block", "package": "com.google.android.youtube", "mode": "block" }
  ]
}
```
Note: on this **device** route, `rules` is directly the **array** of rules. (It differs from the portal route in 5.3 on purpose.)

The app should poll this periodically (WorkManager). A push signal is planned later; polling will remain as the fallback.

### 5.6 Acknowledge a policy (App)
`POST /device/policy/ack`  
Auth: **device token**.

```json
{ "version": 2, "status": "applied", "detail": "optional text up to 500 chars" }
```
- `status`: `applied`, `unsupported` or `failed`
- `version`: must be the **latest** version

**200**
```json
{ "ok": true }
```
Errors: `400 VALIDATION`, `400 NO_POLICY`, `409 STALE_VERSION` (a newer version exists; fetch it again).

---

## 6. Usage

### 6.1 Upload usage (App)
`POST /device/usage`  
Auth: **device token**.

```json
{
  "events": [
    {
      "id": "3f2c1a10-5b7e-4c1a-9d11-000000000001",
      "package": "com.google.android.youtube",
      "startedAt": "2026-11-27T10:00:00Z",
      "durationS": 1200
    }
  ]
}
```
- `events`: 1 to 500 items per request
- `id`: a **UUID the phone generates once per event** and stores with it in Room
- `startedAt`: ISO 8601 date-time in UTC (`...Z`)
- `durationS`: whole seconds, 0 to 86400

**201**
```json
{ "accepted": ["3f2c1a10-5b7e-4c1a-9d11-000000000001"] }
```
`accepted` lists every id now safely stored. **Delete an event locally only after its id appears here.** Re-sending the same event is safe: the backend ignores duplicates and still reports the id as accepted.

Errors: `400 VALIDATION`, `401 DEVICE_REVOKED`.

### 6.2 Raw usage list (Portal)
`GET /devices/:id/usage?from=<ISO>&to=<ISO>&limit=100`  
Auth: **parent token**. All query parameters are optional (`limit` 1-500, default 100).

**200** (newest first)
```json
[
  {
    "id": "3f2c1a10-5b7e-4c1a-9d11-000000000001",
    "package": "com.google.android.youtube",
    "startedAt": "2026-11-27T10:00:00.000Z",
    "durationS": 1200
  }
]
```

### 6.3 Usage summary (Portal)
`GET /devices/:id/usage/summary?from=<ISO>&to=<ISO>`  
Auth: **parent token**. Good for a bar chart.

**200** (largest first)
```json
[
  { "package": "com.google.android.youtube", "totalSeconds": 1200, "sessions": 1 },
  { "package": "com.whatsapp", "totalSeconds": 300, "sessions": 1 }
]
```

---

## 7. End-to-end demo flow (30%)

1. **Portal:** parent logs in, then `POST /devices/pairing-codes` and shows the code.
2. **App:** child enters the code, then `POST /devices/pair` and stores `deviceId` and `token`.
3. **Portal:** `GET /devices` now lists the phone.
4. **Portal:** parent saves the YouTube block with `PUT /devices/:id/policy`; status shows **pending**.
5. **App:** `GET /device/policy?currentVersion=0` returns the rule; the app blocks YouTube.
6. **App:** `POST /device/policy/ack` with `applied`.
7. **Portal:** `GET /devices/:id/policy-status` shows **applied**.
8. **App:** `POST /device/usage`; **Portal** shows `/usage/summary`.

---

## 8. Notes for the Android app (Maisam)

- Use the **emulator address** `10.0.2.2` or the PC's IPv4 on a real phone until the backend is deployed.
- Android blocks plain `http://` by default. For local testing, allow cleartext to the dev host through a network security config. This goes away once the backend has an `https://` URL.
- Add the device token with an OkHttp interceptor: `Authorization: Bearer <token>`.
- Generate each usage event's UUID **once** and store it with the event so retries do not create duplicates.
- On `401 BAD_TOKEN` or `401 DEVICE_REVOKED`, clear the stored token and return to the pairing screen.

## 9. Notes for the parent portal (Mehmood)

- Keep the base URL in `.env` (for example `VITE_API_URL`).
- Store the parent token after login and send it on every request.
- Poll `GET /devices/:id/policy-status` every 3 to 5 seconds on the policy screen to show pending/applied.
- Show `error.message` from failed responses to the user.
- Test account: `parent@test.com` / `password123` (local development only).

---

## Changelog

| Date | Change | By |
|---|---|---|
| 2026-11-27 | First version: auth, pairing, policy, usage | Zohaib |
