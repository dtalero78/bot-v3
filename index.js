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

// ========================================
// CONFIGURACIÓN DEL BOT CONVERSACIONAL
// ========================================
// NOTA: El historial de conversaciones se guarda en WHP (base de datos Wix)

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
    // Obtener conversación actual
    const response = await axios.get(`${WIX_BACKEND_URL}/_functions/obtenerConversacion`, {
      params: { userId }
    });

    // Extraer mensajes tal como están en la BD (ya en formato WHP)
    const mensajesActuales = response.data?.mensajes || [];

    // Actualizar con los mensajes existentes + stopBot
    const updateResponse = await axios.post(`${WIX_BACKEND_URL}/_functions/guardarConversacion`, {
      userId: userId,
      nombre: '',
      mensajes: mensajesActuales,
      stopBot: stopBot
    });

    console.log(`✅ stopBot actualizado a ${stopBot} para ${userId} (${mensajesActuales.length} mensajes preservados)`);
    return updateResponse.data;
  } catch (error) {
    // Si el usuario no existe, crear registro con stopBot
    if (error.response?.status === 404 || error.response?.status === 400) {
      console.log(`ℹ️ Usuario ${userId} no existe. Creando registro con stopBot=${stopBot}`);
      const createResponse = await axios.post(`${WIX_BACKEND_URL}/_functions/guardarConversacion`, {
        userId: userId,
        nombre: '',
        mensajes: [],
        stopBot: stopBot
      });
      return createResponse.data;
    }
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

// ========================================
// FUNCIONES PARA FLUJO DE PAGOS
// ========================================
// NOTA: Este flujo es INDEPENDIENTE del bot conversacional
// No guarda nada en WHP, solo procesa pagos y envía certificados

// Estado en memoria para flujo de pagos (imagen → documento)
const ESTADO_ESPERANDO_DOCUMENTO = 'esperando_documento';
const estadoPagos = new Map(); // userId -> 'esperando_documento' o undefined

// Validar si es cédula (solo números, 6-10 dígitos)
function esCedula(texto) {
  const regex = /^\d{6,10}$/;
  return regex.test(texto.trim());
}

// Clasificar imagen con OpenAI Vision
async function clasificarImagen(base64Image, mimeType) {
  try {
    const response = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: 'Analiza esta imagen y responde ÚNICAMENTE con "comprobante_pago" si es un comprobante de pago, transferencia bancaria o recibo de pago. Si no lo es, responde "no_es_comprobante".'
            },
            {
              type: 'image_url',
              image_url: {
                url: `data:${mimeType};base64,${base64Image}`
              }
            }
          ]
        }
      ],
      max_tokens: 50
    });

    const resultado = response.choices[0].message.content.trim().toLowerCase();
    return resultado.includes('comprobante_pago') ? 'comprobante_pago' : 'no_es_comprobante';
  } catch (error) {
    console.error('Error clasificando imagen:', error);
    return 'error';
  }
}

// Consultar cita en HistoriaClinica por número de documento
async function consultarCita(numeroDocumento) {
  try {
    const response = await axios.get(`${WIX_BACKEND_URL}/_functions/historiaClinicaPorNumeroId`, {
      params: {
        numeroId: numeroDocumento
      }
    });

    if (response.data && response.data.data) {
      const paciente = response.data.data;
      return {
        success: true,
        paciente: {
          nombre: `${paciente.primerNombre || ''} ${paciente.primerApellido || ''}`.trim(),
          fechaConsulta: paciente.fechaConsulta,
          celular: paciente.celular,
          empresa: paciente.empresa
        }
      };
    } else {
      return { success: false, message: 'No se encontró información para ese número de documento' };
    }
  } catch (error) {
    console.error('Error consultando cita:', error.response?.data || error.message);
    return { success: false, message: 'No se encontró cita programada con ese documento' };
  }
}

// Marcar como pagado en Wix y obtener _id del item
async function marcarPagado(cedula) {
  try {
    const response = await axios.post('https://www.bsl.com.co/_functions/marcarPagado', {
      userId: cedula,
      observaciones: 'Pagado'
    }, {
      headers: {
        'Content-Type': 'application/json'
      }
    });

    console.log(`💰 Usuario ${cedula} marcado como pagado`);
    return {
      success: true,
      data: response.data,
      historiaClinicaId: response.data?._id || response.data?.id
    };
  } catch (error) {
    console.error('Error marcando como pagado:', error.response?.data || error.message);
    return { success: false, error: error.message };
  }
}

// ========================================
// FIN FUNCIONES PARA FLUJO DE PAGOS
// ========================================

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

// ========================================
// WEBHOOK BOT CONVERSACIONAL
// ========================================
// Maneja SOLO conversaciones de texto con OpenAI
// - Guarda conversaciones en WHP
// - Maneja stopBot (admin control)
// - NO procesa imágenes (van a /webhook-pagos)
app.post('/webhook', async (req, res) => {
  try {
    console.log('Webhook recibido:', JSON.stringify(req.body, null, 2));

    const message = req.body.messages?.[0];

    if (!message) {
      return res.status(200).json({ status: 'ok', message: 'No message found' });
    }

    // Extraer información del mensaje
    const from = message.from;
    const messageType = message.type;
    const messageText = message.text?.body || message.body || '';
    const chatId = message.chat_id;

    // Ignorar imágenes - son procesadas por /webhook-pagos
    if (messageType === 'image') {
      console.log(`📸 Imagen ignorada en bot conversacional (procesada en /webhook-pagos)`);
      return res.status(200).json({ status: 'ok', message: 'Image ignored - handled by payment webhook' });
    }

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

    // 🔍 VERIFICAR SI EL USUARIO ENVIÓ UNA CÉDULA PARA CONSULTAR SU CITA
    if (esCedula(messageText)) {
      console.log(`🆔 Detectada cédula: ${messageText}. Consultando cita...`);

      const citaInfo = await consultarCita(messageText);

      if (citaInfo.success) {
        const fechaConsulta = new Date(citaInfo.paciente.fechaConsulta);
        const fechaFormateada = fechaConsulta.toLocaleDateString('es-CO', {
          weekday: 'long',
          year: 'numeric',
          month: 'long',
          day: 'numeric'
        });
        const horaFormateada = fechaConsulta.toLocaleTimeString('es-CO', {
          hour: '2-digit',
          minute: '2-digit',
          hour12: true
        });

        const respuesta = `📅 ¡Hola ${citaInfo.paciente.nombre}!\n\nTu consulta está programada para:\n\n📆 ${fechaFormateada}\n🕐 ${horaFormateada}\n\n¿Necesitas algo más?`;

        await sendWhatsAppMessage(from, respuesta);

        // Guardar en historial
        const conversationHistory = [
          { role: 'user', content: messageText },
          { role: 'assistant', content: respuesta }
        ];
        await saveConversationToDB(from, conversationHistory, false, message.from_name || '');

        return res.status(200).json({ status: 'ok', message: 'Appointment info sent' });
      } else {
        const respuesta = `❌ No encontré una cita programada con el documento ${messageText}.\n\n¿Deseas agendar una cita nueva?`;
        await sendWhatsAppMessage(from, respuesta);

        const conversationHistory = [
          { role: 'user', content: messageText },
          { role: 'assistant', content: respuesta }
        ];
        await saveConversationToDB(from, conversationHistory, false, message.from_name || '');

        return res.status(200).json({ status: 'ok', message: 'No appointment found' });
      }
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
      await saveConversationToDB(from, [], false, message.from_name || '');
      await sendWhatsAppMessage(from, '🩺 Nuestras opciones:\nVirtual – $46.000 COP\nPresencial – $69.000 COP');
    } else if (aiResponse === 'AGENDA_COMPLETADA') {
      // Guardar conversación y enviar respuesta
      await sendWhatsAppMessage(from, aiResponse);
      await saveConversationToDB(from, conversationHistory, false, message.from_name || '');
    } else if (aiResponse.includes('...transfiriendo con asesor')) {
      // Enviar mensaje, guardar conversación y marcar stopBot
      await sendWhatsAppMessage(from, aiResponse);
      await saveConversationToDB(from, conversationHistory, false, message.from_name || '');
      await updateStopBotOnly(from, true);
      console.log(`🤖 Bot auto-detenido para ${from} (transferencia a asesor)`);
    } else {
      // Enviar respuesta normal y guardar conversación
      await sendWhatsAppMessage(from, aiResponse);
      await saveConversationToDB(from, conversationHistory, false, message.from_name || '');
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

// ========================================
// WEBHOOK VALIDACIÓN DE PAGOS
// ========================================
// Maneja SOLO validación de pagos con imágenes
// - Valida comprobante con OpenAI Vision
// - Marca pagado en Wix
// - Envía URL del certificado
// - NO guarda conversaciones en WHP
// - Estado en memoria (se pierde al reiniciar)
app.post('/webhook-pagos', async (req, res) => {
  try {
    console.log('💰 Webhook de pagos recibido:', JSON.stringify(req.body, null, 2));

    const message = req.body.messages?.[0];

    if (!message) {
      return res.status(200).json({ status: 'ok', message: 'No message found' });
    }

    const from = message.from;
    const messageType = message.type;
    const messageText = message.text?.body || '';

    // Ignorar mensajes del bot
    if (message.from_me) {
      return res.status(200).json({ status: 'ok', message: 'Message from bot ignored' });
    }

    // Obtener estado del flujo de pago (en memoria)
    const estadoPago = estadoPagos.get(from);

    // FLUJO 1: Usuario envía imagen (comprobante de pago)
    if (messageType === 'image') {
      console.log(`📸 Imagen recibida de ${from}`);

      try {
        // 1. Descargar imagen
        const imageId = message.image?.id;
        const mimeType = message.image?.mime_type || 'image/jpeg';
        const urlImg = `https://gate.whapi.cloud/media/${imageId}`;

        const imageResponse = await axios.get(urlImg, {
          headers: { 'Authorization': `Bearer ${WHAPI_TOKEN}` },
          responseType: 'arraybuffer'
        });

        const base64Image = Buffer.from(imageResponse.data).toString('base64');

        // 2. Validar con OpenAI Vision
        const clasificacion = await clasificarImagen(base64Image, mimeType);

        if (clasificacion !== 'comprobante_pago') {
          const mensaje = `❌ La imagen no parece ser un comprobante de pago válido.\n\nPor favor envía una imagen clara de tu:\n• Comprobante bancario\n• Transferencia\n• Recibo de pago`;
          await sendWhatsAppMessage(from, mensaje);
          return res.status(200).json({ status: 'ok', message: 'Imagen no válida' });
        }

        // 3. Comprobante válido - pedir documento
        const mensaje = `✅ *Comprobante de pago recibido*\n\nPara completar el proceso y generar tu certificado, escribe tu *número de documento* (solo números, sin puntos).\n\nEjemplo: 1234567890`;
        await sendWhatsAppMessage(from, mensaje);

        // Guardar estado en memoria
        estadoPagos.set(from, ESTADO_ESPERANDO_DOCUMENTO);

        console.log(`✅ Comprobante validado para ${from}`);
        return res.status(200).json({ status: 'ok', message: 'Comprobante validado' });

      } catch (error) {
        console.error('Error procesando imagen:', error);
        await sendWhatsAppMessage(from, '❌ No pude procesar tu imagen. Por favor intenta de nuevo.');
        return res.status(500).json({ status: 'error', message: error.message });
      }
    }

    // FLUJO 2: Usuario envía documento (después de enviar imagen)
    if (messageText && estadoPago === ESTADO_ESPERANDO_DOCUMENTO) {
      console.log(`📄 Documento recibido de ${from}: ${messageText}`);

      try {
        const documento = messageText.trim();

        // 1. Validar formato de cédula
        if (!esCedula(documento)) {
          await sendWhatsAppMessage(from, `❌ Por favor escribe un número de documento válido (solo números).\n\nEjemplo: 1234567890`);
          return res.status(200).json({ status: 'ok', message: 'Documento inválido' });
        }

        // 2. Marcar como pagado
        await sendWhatsAppMessage(from, `⏳ Procesando pago para documento ${documento}...`);

        const resultadoPago = await marcarPagado(documento);

        if (!resultadoPago.success) {
          await sendWhatsAppMessage(from, `❌ No encontré un registro con el documento ${documento}.\n\nVerifica que:\n• El número esté correcto\n• Ya hayas realizado tu examen médico`);
          return res.status(200).json({ status: 'ok', message: 'Documento no encontrado' });
        }

        // 3. Generar URL del certificado
        const historiaClinicaId = resultadoPago.historiaClinicaId;

        if (!historiaClinicaId) {
          await sendWhatsAppMessage(from, `✅ *Pago registrado*\n\n⚠️ No pude generar el enlace del certificado. Un asesor te contactará pronto.`);
          return res.status(200).json({ status: 'ok', message: 'Pago registrado sin ID' });
        }

        const pdfUrl = `https://bsl-utilidades-yp78a.ondigitalocean.app/static/solicitar-certificado.html?id=${historiaClinicaId}`;

        // 4. Enviar respuesta con el enlace
        const mensajeFinal = `🎉 *¡Pago registrado exitosamente!*\n\n✅ Documento: ${documento}\n📄 Puedes descargar tu certificado médico aquí:\n\n${pdfUrl}\n\n¡Gracias por tu pago!`;
        await sendWhatsAppMessage(from, mensajeFinal);

        // Limpiar estado en memoria
        estadoPagos.delete(from);

        console.log(`✅ Pago procesado para ${from} - Documento: ${documento}`);
        return res.status(200).json({ status: 'ok', message: 'Pago procesado' });

      } catch (error) {
        console.error('Error procesando documento:', error);
        await sendWhatsAppMessage(from, '❌ Hubo un error procesando tu pago. Por favor intenta de nuevo.');
        return res.status(500).json({ status: 'error', message: error.message });
      }
    }

    // Si no está en el flujo de pagos, ignorar
    return res.status(200).json({ status: 'ok', message: 'Not in payment flow' });

  } catch (error) {
    console.error('Error en webhook-pagos:', error);
    return res.status(500).json({ status: 'error', message: error.message });
  }
});

app.get('/webhook-pagos', (req, res) => {
  res.status(200).send('Webhook de pagos is active');
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
