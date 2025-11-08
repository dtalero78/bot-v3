require('dotenv').config();
const express = require('express');
const axios = require('axios');
const OpenAI = require('openai');

// Importar el prompt del sistema
const { systemPrompt } = require('./prompt');

const app = express();
app.use(express.json());

// Configurar OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_KEY,
});

// Configuración de Whapi
const WHAPI_BASE_URL = 'https://gate.whapi.cloud';
const WHAPI_TOKEN = process.env.WHAPI_KEY;

// Configuración de Wix Backend
const WIX_BACKEND_URL = process.env.WIX_BACKEND_URL;

// Almacenar conversaciones en memoria (en producción, usar una base de datos)
const conversations = new Map();

// Función para enviar mensajes a través de Whapi
async function sendWhatsAppMessage(to, message) {
  try {
    const response = await axios.post(
      `${WHAPI_BASE_URL}/messages/text`,
      {
        typing_time: 0,
        to: to,
        body: message,
      },
      {
        headers: {
          'Authorization': `Bearer ${WHAPI_TOKEN}`,
          'Content-Type': 'application/json',
        },
      }
    );
    console.log('Mensaje enviado:', response.data);
    return response.data;
  } catch (error) {
    console.error('Error enviando mensaje:', error.response?.data || error.message);
    throw error;
  }
}

// Función para verificar si el usuario tiene stopBot activo en WHP
async function checkStopBot(userId) {
  try {
    const response = await axios.get(`${WIX_BACKEND_URL}/_functions/obtenerConversacion`, {
      params: { userId }
    });

    if (response.data && response.data.stopBot === true) {
      console.log(`🛑 Usuario ${userId} tiene stopBot activo. No se enviará respuesta.`);
      return true;
    }

    return false;
  } catch (error) {
    // Si no existe el usuario en la BD o hay error, permitir que el bot responda
    if (error.response?.status === 404 || error.response?.status === 400) {
      console.log(`ℹ️ Usuario ${userId} no encontrado en WHP. Permitiendo interacción.`);
      return false;
    }
    console.error('Error consultando stopBot:', error.message);
    return false;
  }
}

// Función para obtener respuesta de OpenAI
async function getAIResponse(userMessage, conversationHistory = []) {
  try {
    const messages = [
      { role: 'system', content: systemPrompt },
      ...conversationHistory,
      { role: 'user', content: userMessage }
    ];

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: messages,
      temperature: 0.7,
      max_tokens: 500,
    });

    return completion.choices[0].message.content;
  } catch (error) {
    console.error('Error con OpenAI:', error);
    return 'Lo siento, tuve un problema técnico. ¿Podrías repetir tu pregunta?';
  }
}

// Webhook para recibir mensajes de Whapi
app.post('/webhook', async (req, res) => {
  try {
    console.log('Webhook recibido:', JSON.stringify(req.body, null, 2));

    const message = req.body.messages?.[0];

    if (!message) {
      return res.status(200).json({ status: 'ok', message: 'No message found' });
    }

    // Ignorar mensajes enviados por el bot
    if (message.from_me) {
      return res.status(200).json({ status: 'ok', message: 'Message from bot ignored' });
    }

    // Extraer información del mensaje
    const from = message.from;
    const messageText = message.text?.body || message.body || '';

    if (!messageText) {
      return res.status(200).json({ status: 'ok', message: 'Empty message' });
    }

    console.log(`Mensaje de ${from}: ${messageText}`);

    // 🛑 VERIFICAR SI EL USUARIO TIENE STOPBOT ACTIVO
    const isStopped = await checkStopBot(from);
    if (isStopped) {
      console.log(`⛔ Bot detenido para ${from}. No se procesará el mensaje.`);
      return res.status(200).json({
        status: 'ok',
        message: 'Bot stopped for this user'
      });
    }

    // Obtener historial de conversación
    let conversationHistory = conversations.get(from) || [];

    // Obtener respuesta de AI
    const aiResponse = await getAIResponse(messageText, conversationHistory);

    // Actualizar historial
    conversationHistory.push(
      { role: 'user', content: messageText },
      { role: 'assistant', content: aiResponse }
    );

    // Mantener solo los últimos 10 mensajes (5 intercambios)
    if (conversationHistory.length > 10) {
      conversationHistory = conversationHistory.slice(-10);
    }

    conversations.set(from, conversationHistory);

    // Verificar comandos especiales
    if (aiResponse === 'VOLVER_AL_MENU') {
      // Limpiar historial y enviar menú
      conversations.delete(from);
      await sendWhatsAppMessage(from, '🩺 Nuestras opciones:\nVirtual – $46.000 COP\nPresencial – $69.000 COP');
    } else if (aiResponse === 'AGENDA_COMPLETADA') {
      // Aquí podrías agregar lógica adicional si es necesario
      await sendWhatsAppMessage(from, aiResponse);
    } else if (aiResponse.includes('...transfiriendo con asesor')) {
      // Enviar mensaje y detener el bot para este usuario
      await sendWhatsAppMessage(from, aiResponse);
      conversations.delete(from);
    } else {
      // Enviar respuesta normal
      await sendWhatsAppMessage(from, aiResponse);
    }

    res.status(200).json({ status: 'ok', message: 'Message processed' });
  } catch (error) {
    console.error('Error procesando webhook:', error);
    res.status(500).json({ status: 'error', message: error.message });
  }
});

// Endpoint de verificación
app.get('/webhook', (req, res) => {
  res.status(200).send('Webhook is active');
});

// Endpoint de salud
app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    conversations: conversations.size
  });
});

// Iniciar servidor
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🤖 Bot de WhatsApp corriendo en puerto ${PORT}`);
  console.log(`📱 Webhook URL: http://localhost:${PORT}/webhook`);
  console.log(`💚 Health check: http://localhost:${PORT}/health`);
});
