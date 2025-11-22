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

// ID del grupo autorizado para consultas de cédula
const GRUPO_CONSULTAS_ID = process.env.GRUPO_CONSULTAS_ID;

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
    // No lanzar excepción, solo loguear - permite que el flujo continúe
    return { success: false, error: error.message };
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
          fechaAtencion: paciente.fechaAtencion,
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

// Consultar estado completo del paciente (HistoriaClinica + FORMULARIO)
async function consultarEstadoPaciente(numeroDocumento) {
  try {
    // 1. Buscar en HistoriaClinica
    const historiaResponse = await axios.get(`${WIX_BACKEND_URL}/_functions/historiaClinicaPorNumeroId`, {
      params: {
        numeroId: numeroDocumento
      }
    });

    if (!historiaResponse.data || !historiaResponse.data.data) {
      return { success: false, message: 'No se encontró información para ese número de documento' };
    }

    const paciente = historiaResponse.data.data;
    const historiaId = paciente._id;
    const nombre = `${paciente.primerNombre || ''} ${paciente.primerApellido || ''}`.trim();
    const ciudad = paciente.ciudad || '';
    const fechaAtencion = paciente.fechaAtencion ? new Date(paciente.fechaAtencion) : null;
    const fechaConsulta = paciente.fechaConsulta ? new Date(paciente.fechaConsulta) : null;
    const ahora = new Date();

    // 2. Buscar en FORMULARIO usando el _id de HistoriaClinica
    let tieneFormulario = false;
    try {
      const formularioResponse = await axios.get(`${WIX_BACKEND_URL}/_functions/formularioPorIdGeneral`, {
        params: {
          idGeneral: historiaId
        }
      });
      console.log(`🔍 DEBUG formulario response para ${numeroDocumento}:`, JSON.stringify(formularioResponse.data));
      tieneFormulario = formularioResponse.data?.success === true;
      console.log(`🔍 DEBUG tieneFormulario = ${tieneFormulario}`);
    } catch (error) {
      console.log(`ℹ️ No se encontró formulario para ${numeroDocumento}`, error.message);
      tieneFormulario = false;
    }

    // 3. Evaluar condiciones (en zona horaria de Colombia)
    console.log(`🔍 DEBUG Antes de evaluar condiciones - fechaAtencion:`, fechaAtencion, `fechaConsulta:`, fechaConsulta);
    let estado = '';
    let estadoDetalle = '';

    // Condición 1: Si tiene fechaConsulta que ya pasó
    if (fechaConsulta && fechaConsulta < ahora) {
      console.log(`🔍 DEBUG Entró en condición 1`);
      estado = '✅ Ya está listo';
      estadoDetalle = 'consulta_realizada';
    }
    // Condición 2: Si tiene fechaConsulta pero NO tiene formulario
    else if (fechaConsulta && !tieneFormulario) {
      estado = '⚠️ Ya tuvo consulta pero le falta terminar el link';
      estadoDetalle = 'falta_formulario';
    }
    // Condición 3: Si tiene fechaAtencion que ya pasó, NO tiene fechaConsulta y NO tiene formulario
    else if (fechaAtencion && fechaAtencion < ahora && !fechaConsulta && !tieneFormulario) {
      estado = '❌ No realizó la consulta, ni diligenció link';
      estadoDetalle = 'no_realizo_consulta';
    }
    // Otros casos (cita programada pendiente, etc.)
    else if (fechaAtencion && fechaAtencion >= ahora) {
      // Formatear fecha para mostrar
      const dia = fechaAtencion.toLocaleDateString('es-CO', { day: 'numeric', timeZone: 'America/Bogota' });
      const mes = fechaAtencion.toLocaleDateString('es-CO', { month: 'short', timeZone: 'America/Bogota' });
      const año = fechaAtencion.toLocaleDateString('es-CO', { year: 'numeric', timeZone: 'America/Bogota' });
      const hora = fechaAtencion.toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit', hour12: false, timeZone: 'America/Bogota' });

      estado = `📅 Cita programada: ${dia} ${mes} ${año} ${hora}`;
      estadoDetalle = 'cita_programada';
    } else {
      estado = 'ℹ️ Estado no determinado';
      estadoDetalle = 'indeterminado';
    }

    console.log(`🔍 DEBUG Antes del return - success: true, nombre: ${nombre}, tieneFormulario: ${tieneFormulario}`);
    return {
      success: true,
      nombre,
      ciudad,
      estado,
      estadoDetalle,
      tieneFormulario,
      fechaAtencion,
      fechaConsulta
    };

  } catch (error) {
    console.error('❌ ERROR en consultarEstadoPaciente:', error.response?.data || error.message);
    console.error('❌ ERROR stack:', error.stack);
    return { success: false, message: 'Error al consultar el estado del paciente' };
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

    // Detectar si el mensaje viene de un grupo de WhatsApp
    const isGroupMessage = chatId && chatId.includes('@g.us');

    // Verificar si es el grupo autorizado para consultas
    const isAuthorizedGroup = GRUPO_CONSULTAS_ID && chatId === GRUPO_CONSULTAS_ID;

    if (isGroupMessage && !isAuthorizedGroup) {
      console.log(`📱 Mensaje de grupo no autorizado detectado. Ignorando mensaje de ${from}.`);
      return res.status(200).json({ status: 'ok', message: 'Group message ignored' });
    }

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

    // 👨‍💼 VERIFICAR SI EL MENSAJE ES DEL ADMIN (solo en chats individuales, no en grupos)
    if (from === ADMIN_NUMBER && message.from_me && !isGroupMessage) {
      console.log('📨 Mensaje del administrador detectado (chat individual)');

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
      } else if (messageText === 'Revisa que todo esté en orden') {
        console.log(`🎯 Comando detectado: enviar números de cuenta para ${userId}`);
        const numerosCC = `💳 *Medios de pago BSL*

📌 *Bancolombia*
Ahorros: 44291192456
Cédula: 79981585

📌 *Daviplata*
3014400818 (Mar Rea)

📌 *Nequi*
3008021701 (Dan Tal)

📌 *Transfiya*
También disponible

Por favor envía el comprobante de pago cuando completes la transferencia.`;

        await sendWhatsAppMessage(userId, numerosCC);
        console.log(`✅ Números de cuenta enviados a ${userId}`);
      } else {
        console.log(`⚠️ Mensaje del admin no coincide con comandos conocidos`);
      }

      // Los mensajes del admin no se procesan con el bot
      return res.status(200).json({
        status: 'ok',
        message: 'Admin message processed'
      });
    }

    // Ignorar otros mensajes enviados por el bot
    if (message.from_me) {
      return res.status(200).json({ status: 'ok', message: 'Message from bot ignored' });
    }

    // 🛑 VERIFICAR stopBot ANTES de procesar cualquier mensaje (incluyendo cédulas)
    // Excepto para grupos autorizados donde las consultas de cédula siempre funcionan
    if (!isAuthorizedGroup) {
      const conversationData = await getConversationFromDB(from);

      if (conversationData.stopBot) {
        console.log(`⛔ Bot detenido para ${from}. No se procesará el mensaje.`);
        return res.status(200).json({
          status: 'ok',
          message: 'Bot stopped for this user'
        });
      }
    }

    // 🔍 VERIFICAR SI EL USUARIO ENVIÓ UNA CÉDULA PARA CONSULTAR SU CITA
    if (esCedula(messageText)) {
      console.log(`🆔 Detectada cédula: ${messageText}. Consultando información...`);

      // Si es del grupo autorizado, usar consulta completa (HistoriaClinica + FORMULARIO)
      if (isAuthorizedGroup) {
        const estadoPaciente = await consultarEstadoPaciente(messageText);

        if (estadoPaciente.success) {
          const respuesta = `${estadoPaciente.nombre} - ${estadoPaciente.ciudad}\n${estadoPaciente.estado}`;
          await sendWhatsAppMessage(chatId, respuesta);
          return res.status(200).json({ status: 'ok', message: 'Patient status sent to group' });
        } else {
          await sendWhatsAppMessage(chatId, `❌ No encontré información con el documento ${messageText}`);
          return res.status(200).json({ status: 'ok', message: 'Patient not found' });
        }
      }

      // Si es mensaje directo, usar consulta completa (HistoriaClinica + FORMULARIO)
      const estadoPaciente = await consultarEstadoPaciente(messageText);

      if (estadoPaciente.success) {
        const ahora = new Date();
        const fechaConsulta = estadoPaciente.fechaConsulta;
        const fechaAtencion = estadoPaciente.fechaAtencion;
        const tieneFormulario = estadoPaciente.tieneFormulario;

        console.log(`🔍 DEBUG ahora:`, ahora);
        console.log(`🔍 DEBUG fechaConsulta:`, fechaConsulta);
        console.log(`🔍 DEBUG fechaAtencion:`, fechaAtencion);
        console.log(`🔍 DEBUG tieneFormulario:`, tieneFormulario);
        console.log(`🔍 DEBUG fechaAtencion >= ahora:`, fechaAtencion >= ahora);

        let respuesta = '';
        let debeDetenerBot = false;

        // Condición 1: fechaConsulta pasó + tiene FORMULARIO
        if (fechaConsulta && fechaConsulta < ahora && tieneFormulario) {
          respuesta = '✅ ¡Tu certificado ya está listo!';
          debeDetenerBot = true;
        }
        // Condición 2: fechaConsulta pasó + NO tiene FORMULARIO
        else if (fechaConsulta && fechaConsulta < ahora && !tieneFormulario) {
          respuesta = 'Te falta terminar el formulario. Continúa en este link:\n\nhttps://www.bsl.com.co/desbloqueo';
        }
        // Condición 3: fechaAtencion NO ha pasado + tiene FORMULARIO
        else if (fechaAtencion && fechaAtencion >= ahora && tieneFormulario) {
          const dia = fechaAtencion.toLocaleDateString('es-CO', { day: 'numeric', timeZone: 'America/Bogota' });
          const mes = fechaAtencion.toLocaleDateString('es-CO', { month: 'short', timeZone: 'America/Bogota' });
          const año = fechaAtencion.toLocaleDateString('es-CO', { year: 'numeric', timeZone: 'America/Bogota' });
          const hora = fechaAtencion.toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit', hour12: false, timeZone: 'America/Bogota' });

          respuesta = `${estadoPaciente.nombre} - ${dia} ${mes} ${año} ${hora}`;
        }
        // Condición 4: fechaAtencion NO ha pasado + NO tiene FORMULARIO
        else if (fechaAtencion && fechaAtencion >= ahora && !tieneFormulario) {
          respuesta = 'Te falta terminar el formulario. Continúa en este link:\n\nhttps://www.bsl.com.co/desbloqueo';
        }
        // Otros casos
        else {
          respuesta = '❌ No encontré información de tu cita. Por favor contacta a un asesor.';
        }

        await sendWhatsAppMessage(from, respuesta);

        // Si debe detener el bot, ejecutar updateStopBotOnly
        if (debeDetenerBot) {
          await updateStopBotOnly(from, true);
          console.log(`🛑 Bot detenido para ${from} - certificado listo`);
        }

        // Guardar en historial
        const conversationHistory = [
          { role: 'user', content: messageText },
          { role: 'assistant', content: respuesta }
        ];
        await saveConversationToDB(from, conversationHistory, debeDetenerBot, message.from_name || '');

        return res.status(200).json({ status: 'ok', message: 'Patient info sent' });
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

    // Si el mensaje viene del grupo autorizado y no es una cédula, ignorar
    // (los mensajes de grupo solo se procesan si son cédulas, ya se manejó arriba)
    if (isAuthorizedGroup) {
      console.log(`📱 Mensaje de grupo autorizado ignorado (no es cédula): ${messageText}`);
      return res.status(200).json({ status: 'ok', message: 'Group message processed' });
    }

    // Obtener conversación desde la base de datos para procesar con OpenAI
    const conversationData = await getConversationFromDB(from);

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
    const chatId = message.chat_id;

    // Detectar si el mensaje viene de un grupo de WhatsApp
    const isGroupMessage = chatId && chatId.includes('@g.us');

    if (isGroupMessage) {
      console.log(`📱 Mensaje de grupo detectado en webhook-pagos. Ignorando mensaje de ${from}.`);
      return res.status(200).json({ status: 'ok', message: 'Group message ignored' });
    }

    // Detectar comando de admin "...dame un momento"
    if (message.from_me && from === ADMIN_NUMBER && messageText.includes('...dame un momento')) {
      // Extraer userId del chatId (formato: "573123456789@s.whatsapp.net")
      const userId = chatId.split('@')[0];

      // Cancelar flujo de pago en progreso (silenciosamente)
      if (estadoPagos.has(userId)) {
        estadoPagos.delete(userId);
        console.log(`🔄 Admin canceló flujo de pago para ${userId}`);
      }

      return res.status(200).json({ status: 'ok', message: 'Payment flow cancelled by admin' });
    }

    // Ignorar otros mensajes del bot
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
          const mensaje = `...transfiriendo con asesor`;
          await sendWhatsAppMessage(from, mensaje);

          // Marcar stopBot como true para transferir a humano
          await updateStopBotOnly(from, true);

          return res.status(200).json({ status: 'ok', message: 'Imagen no válida - transferido a asesor' });
        }

        // 3. Comprobante válido - pedir documento
        const mensaje = `✅ *Comprobante de pago recibido*\n\nEscribe tu *número de documento* (solo números, sin puntos).\n\nEjemplo: 1234567890`;
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
        const mensajeFinal = `🎉 *¡Pago registrado exitosamente!*\n\nDescarga tu certificado haciendo clic en el siguiente link:\n\n${pdfUrl}`;
        await sendWhatsAppMessage(from, mensajeFinal);

        // 5. Marcar stopBot como true para detener el bot
        await updateStopBotOnly(from, true);

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
