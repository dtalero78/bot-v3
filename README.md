# Bot WhatsApp BSL - Exámenes Médicos Ocupacionales

Bot automático de WhatsApp para BSL que responde consultas sobre exámenes médicos ocupacionales usando OpenAI y Whapi Cloud.

## Requisitos

- Node.js 16 o superior
- Cuenta de OpenAI con API Key
- Cuenta de Whapi Cloud con token de API

## Instalación

```bash
npm install
```

## Configuración

El archivo `.env` ya está configurado con:

- `OPENAI_KEY`: Tu API key de OpenAI
- `WHAPI_KEY`: Tu token de Whapi Cloud
- `WHAPI_CHANNEL_ID`: ID de tu canal de Whapi
- `PORT`: Puerto del servidor (8080)

## Uso

### Iniciar el bot

```bash
npm start
```

### Modo desarrollo (con auto-reload)

```bash
npm run dev
```

## Configurar Webhook en Whapi Cloud

1. Ve a tu dashboard de Whapi Cloud
2. Navega a Settings > Webhooks
3. Configura el webhook URL como: `https://tu-dominio.com/webhook`
4. Activa el webhook para eventos de mensajes

Si estás en desarrollo local, usa ngrok:

```bash
ngrok http 8080
```

Luego usa la URL de ngrok como tu webhook.

## Características

- Responde automáticamente a mensajes de WhatsApp
- Usa el prompt personalizado de [prompt.js](prompt.js)
- Mantiene contexto de conversaciones
- Maneja comandos especiales:
  - `VOLVER_AL_MENU`: Reinicia la conversación
  - `AGENDA_COMPLETADA`: Confirma agendamiento
  - `...transfiriendo con asesor`: Transfiere a humano

## Estructura del Proyecto

```
bot-v3/
├── index.js          # Servidor principal y lógica del bot
├── prompt.js         # Prompt del sistema para OpenAI
├── .env              # Variables de entorno
├── package.json      # Dependencias
└── README.md         # Este archivo
```

## Endpoints

- `POST /webhook`: Recibe mensajes de Whapi Cloud
- `GET /webhook`: Verifica que el webhook está activo
- `GET /health`: Estado del servidor

## Tecnologías

- Express.js: Servidor web
- OpenAI API: Inteligencia artificial
- Whapi Cloud: Integración con WhatsApp
- Axios: Cliente HTTP
