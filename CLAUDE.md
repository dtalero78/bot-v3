# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

BSL WhatsApp Bot for medical occupational exams. Handles appointment scheduling, payment validation, and AI-powered conversations using OpenAI GPT-4o-mini and Whapi Cloud.

## Development Commands

```bash
npm start        # Production mode
npm run dev      # Development with nodemon auto-reload
ngrok http 8080  # Expose local server for webhook testing
```

## Critical Architecture: Dual Webhook System

This application uses **TWO separate webhooks** with completely different responsibilities:

### `/webhook` - Conversational Bot
- Handles text-based AI conversations with OpenAI
- Appointment lookup by cédula (document number)
- Admin control commands (pause/resume bot)
- **State:** Persistent in Wix database (WHP collection)
- **Ignores images** to avoid conflicts with payment webhook

### `/webhook-pagos` - Payment Validation
- Validates payment receipts using OpenAI Vision
- Two-step flow: image validation → document collection
- Generates certificate download URLs
- **State:** In-memory Map (ephemeral, lost on restart)
- **Does NOT save to WHP database**

**Both webhooks must be configured separately in Whapi Cloud dashboard.**

## State Management

### Conversational Bot (`/webhook`)
- **Storage:** Wix WHP collection
- **Persistence:** Permanent
- **Structure:**
  ```javascript
  {
    userId: "573XXXXXXXXX",  // WhatsApp number
    nombre: "User Name",
    mensajes: [
      { from: "usuario", mensaje: "text", timestamp: "2025-..." },
      { from: "bot", mensaje: "text", timestamp: "2025-..." }
    ],
    stopBot: false,  // Controls if bot responds
    threadId: "thread_..."
  }
  ```

### Payment Flow (`/webhook-pagos`)
- **Storage:** In-memory `estadoPagos` Map
- **Values:** `"esperando_documento"` after valid image
- **Cleared:** After successful payment or on restart

## Admin Control System

Admins (ADMIN_NUMBER: 573008021701) can control the bot:

```javascript
// Pause bot (transfer to human)
if (messageText.includes("...transfiriendo con asesor")) {
  await updateStopBotOnly(userId, true);
}

// Resume bot
if (messageText.includes("...te dejo con el bot 🤖")) {
  await updateStopBotOnly(userId, false);
}
```

Detection requires BOTH conditions:
- `from === ADMIN_NUMBER`
- `from_me === true`

## External Service Integration

### OpenAI
- **Model:** gpt-4o-mini
- **Temperature:** 0.7
- **Max Tokens:** 500
- **Vision:** Used in payment webhook for image classification
- **Context:** Last 10 messages (5 exchanges)

### Whapi Cloud
- **Base URL:** https://gate.whapi.cloud
- **Auth:** Bearer token in headers
- **Endpoints:**
  - `POST /messages/text` - Send messages
  - `GET /media/{id}` - Download images

### Wix Backend (`FUNCIONES WIX/http.js`)
- **Base URL:** https://www.bsl.com.co/_functions/
- **Key Endpoints:**
  - `guardarConversacion` - Save/update conversation history
  - `obtenerConversacion` - Get conversation by userId
  - `historiaClinicaPorNumeroId` - Lookup appointment by cédula
  - `marcarPagado` - Mark payment complete, returns `{ success: true, _id: "..." }`

## Key Flows

### Appointment Lookup
1. User sends cédula (6-10 digits validated by `esCedula()`)
2. Call `consultarCita(numeroDocumento)` → Wix
3. Format date with Colombia timezone: `America/Bogota`
4. Return: `{nombre} - {day} {month} {year} {time}`

### Payment Validation
1. User sends image → OpenAI Vision validates as payment receipt
2. Set `estadoPagos.set(from, 'esperando_documento')`
3. User sends cédula → validate format
4. Call `marcarPagado(cedula)` → get `historiaClinicaId`
5. Generate certificate URL: `https://bsl-utilidades-yp78a.ondigitalocean.app/static/solicitar-certificado.html?id={historiaClinicaId}`
6. Call `updateStopBotOnly(from, true)` to stop bot
7. Clear `estadoPagos.delete(from)`

## Special Commands

### System Commands (from OpenAI)
- `VOLVER_AL_MENU` - Clears history, shows main menu
- `AGENDA_COMPLETADA` - User confirmed scheduling
- `...transfiriendo con asesor` - Transfer to human, stops bot

### User Triggers
- **Cédula pattern** (6-10 digits) → Appointment lookup
- **Image in `/webhook-pagos`** → Payment validation flow
- **"menú"** or **"volver al menú"** → Reset conversation

## Important Patterns and Gotchas

1. **Never merge the two webhooks** - they have fundamentally different state management
2. **Payment state is ephemeral** - lost on server restart
3. **Admin detection requires TWO checks** - both `from` and `from_me`
4. **Message duplication** - Main webhook ignores images to prevent duplicate processing
5. **Timezone handling** - Always use `'America/Bogota'` for date formatting
6. **Context window** - Limited to last 10 messages to manage OpenAI tokens
7. **Certificate generation** - Requires `_id` field from `marcarPagado` response
8. **stopBot control** - Automatically set to true after payment completion

## Database Collections (Wix)

### WHP
- Purpose: Conversation history for external bot
- Used by: `/webhook` endpoint only

### HistoriaClinica
- Purpose: Patient medical records and appointments
- Key fields: `numeroId` (cédula), `fechaAtencion`, `pvEstado`, `_id`
- Used by: Both webhooks for appointments and payment

## Deployment

**Production Server:**
- DigitalOcean App Platform
- URL: Not documented (check deployment dashboard)

**Webhook Configuration:**
Configure TWO webhooks in Whapi Cloud:
1. `https://your-domain.com/webhook` - For messages
2. `https://your-domain.com/webhook-pagos` - For images/payments

**Health Check:**
```bash
GET /health  # Returns { status: 'Bot is active', persistence: {...} }
```

## Logging Conventions

Emojis used for log clarity:
- 📸 Image processing
- 💰 Payment operations
- 💾 Database saves
- ✅ Success
- ❌ Errors
- 🔍 Debug information
- 📨 Admin messages
