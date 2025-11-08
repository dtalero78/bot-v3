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

// Número del administrador
const ADMIN_NUMBER = process.env.ADMIN_NUMBER;

// NOTA: El historial de conversaciones ahora se guarda en WHP (base de datos Wix)
// Ya no usamos Map() en memoria para persistir entre reinicios

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

// Función para obtener la conversación completa desde WHP
async function getConversationFromDB(userId) {
  try {
    const response = await axios.get(`${WIX_BACKEND_URL}/_functions/obtenerConversacion`, {
      params: { userId }
    });

    if (response.data) {
      return {
        stopBot: response.data.stopBot === true,
        mensajes: response.data.mensajes || [],
        observaciones: response.data.observaciones || '',
        threadId: response.data.threadId || ''
      };
    }

    return { stopBot: false, mensajes: [], observaciones: '', threadId: '' };
  } catch (error) {
    // Si no existe el usuario en la BD o hay error, devolver valores por defecto
    if (error.response?.status === 404 || error.response?.status === 400) {
      console.log(`ℹ️ Usuario ${userId} no encontrado en WHP. Iniciando nueva conversación.`);
      return { stopBot: false, mensajes: [], observaciones: '', threadId: '' };
    }
    console.error('Error consultando WHP:', error.message);
    return { stopBot: false, mensajes: [], observaciones: '', threadId: '' };
  }
}

// Función para actualizar solo el campo stopBot en WHP
async function updateStopBotOnly(userId, stopBot) {
  try {
    // Primero obtenemos la conversación actual para no perder los mensajes
    const current = await getConversationFromDB(userId);

    // Convertir mensajes existentes de vuelta a formato WHP
    const mensajesWHP = current.mensajes.map(msg => ({
      from: msg.from,
      mensaje: msg.mensaje,
      timestamp: msg.timestamp || new Date().toISOString()
    }));

    const response = await axios.post(`${WIX_BACKEND_URL}/_functions/guardarConversacion`, {
      userId: userId,
      nombre: '',
      mensajes: mensajesWHP,
      stopBot: stopBot
    });

    console.log(`✅ stopBot actualizado a ${stopBot} para ${userId}`);
    return response.data;
  } catch (error) {
    console.error('Error actualizando stopBot:', error.response?.data || error.message);
    throw error;
  }
}

// Función para guardar conversación completa en WHP
async function saveConversationToDB(userId, mensajes, stopBot = false, nombre = '') {
  try {
    // Convertir el formato OpenAI a formato WHP
    const mensajesWHP = mensajes.map(msg => ({
      from: msg.role === 'user' ? 'usuario' : 'bot',
      mensaje: msg.content,
      timestamp: new Date().toISOString()
    }));

    const response = await axios.post(`${WIX_BACKEND_URL}/_functions/guardarConversacion`, {
      userId: userId,
      nombre: nombre,
      mensajes: mensajesWHP,
      stopBot: stopBot
    });

    console.log(`💾 Conversación guardada para ${userId} (${mensajes.length} mensajes)`);
    return response.data;
  } catch (error) {
    console.error('Error guardando conversación:', error.response?.data || error.message);
    throw error;
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

    // Extraer información del mensaje
    const from = message.from;
    const messageText = message.text?.body || message.body || '';
    const chatId = message.chat_id;

    if (!messageText) {
      return res.status(200).json({ status: 'ok', message: 'Empty message' });
    }

    console.log(`Mensaje de ${from}: ${messageText}`);
    console.log(`🔍 Debug: from="${from}", ADMIN_NUMBER="${ADMIN_NUMBER}", from_me=${message.from_me}`);
    console.log(`🔍 Debug: chatId="${chatId}"`);

    // 👨‍💼 VERIFICAR SI EL MENSAJE ES DEL ADMIN (exactamente como el ejemplo)
    if (from === ADMIN_NUMBER && message.from_me) {
      console.log('📨 Mensaje del administrador detectado');

      // Extraer el userId del chat_id (remover @s.whatsapp.net)
      const userId = chatId ? chatId.split('@')[0].trim() : null;
      console.log(`🔍 Debug: userId extraído="${userId}"`);

      if (!userId) {
        console.log('❌ No se pudo extraer userId del chatId');
        return res.status(200).json({ status: 'ok', message: 'No chatId found' });
      }

      console.log(`🔍 Debug: messageText="${messageText}"`);

      // Verificar si el admin quiere detener o reactivar el bot
      if (messageText === '...transfiriendo con asesor') {
        console.log(`🎯 Comando detectado: detener bot para ${userId}`);
        await updateStopBotOnly(userId, true);
        console.log(`🛑 Bot detenido para ${userId} por el administrador`);
      } else if (messageText === '...te dejo con el bot 🤖') {
        console.log(`🎯 Comando detectado: reactivar bot para ${userId}`);
        await updateStopBotOnly(userId, false);
        console.log(`✅ Bot reactivado para ${userId} por el administrador`);
      } else {
        console.log(`⚠️ Mensaje del admin no coincide con comandos conocidos`);
      }

      // Los mensajes del admin no se procesan con el bot
      return res.status(200).json({
        status: 'ok',
        message: 'Admin message processed'
      });
    }

    // Ignorar otros mensajes enviados por el bot (que no son del admin)
    if (message.from_me) {
      return res.status(200).json({ status: 'ok', message: 'Message from bot ignored' });
    }

    // 🛑 OBTENER CONVERSACIÓN DESDE LA BASE DE DATOS
    const conversationData = await getConversationFromDB(from);

    if (conversationData.stopBot) {
      console.log(`⛔ Bot detenido para ${from}. No se procesará el mensaje.`);
      return res.status(200).json({
        status: 'ok',
        message: 'Bot stopped for this user'
      });
    }

    // Convertir mensajes de WHP a formato OpenAI
    let conversationHistory = conversationData.mensajes.map(msg => ({
      role: msg.from === 'usuario' ? 'user' : 'assistant',
      content: msg.mensaje
    }));

    // Mantener solo los últimos 10 mensajes (5 intercambios) para el contexto
    if (conversationHistory.length > 10) {
      conversationHistory = conversationHistory.slice(-10);
    }

    // Obtener respuesta de AI
    const aiResponse = await getAIResponse(messageText, conversationHistory);

    // Actualizar historial con el nuevo intercambio
    conversationHistory.push(
      { role: 'user', content: messageText },
      { role: 'assistant', content: aiResponse }
    );

    // Verificar comandos especiales
    if (aiResponse === 'VOLVER_AL_MENU') {
      // Limpiar historial y enviar menú
      await saveConversationToDB(from, []);
      await sendWhatsAppMessage(from, '🩺 Nuestras opciones:\nVirtual – $46.000 COP\nPresencial – $69.000 COP');
    } else if (aiResponse === 'AGENDA_COMPLETADA') {
      // Aquí podrías agregar lógica adicional si es necesario
      await sendWhatsAppMessage(from, aiResponse);
    } else if (aiResponse.includes('...transfiriendo con asesor')) {
      // Enviar mensaje, marcar stopBot y detener el bot para este usuario
      await sendWhatsAppMessage(from, aiResponse);
      await updateStopBotOnly(from, true);
      console.log(`🤖 Bot auto-detenido para ${from} (transferencia a asesor)`);
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
    persistence: 'WHP Database (Wix)'
  });
});

// Iniciar servidor
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🤖 Bot de WhatsApp corriendo en puerto ${PORT}`);
  console.log(`📱 Webhook URL: http://localhost:${PORT}/webhook`);
  console.log(`💚 Health check: http://localhost:${PORT}/health`);
});
