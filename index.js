require('dotenv').config();
const express = require('express');
const axios = require('axios');
const { Pool } = require('pg');

console.log('🚀 BSL WhatsApp Bot - Solo Grupo de Consultas');

// ========================================
// CONFIGURACIÓN POSTGRESQL (DigitalOcean)
// ========================================
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: {
    rejectUnauthorized: false
  }
});

// Verificar conexión a PostgreSQL al iniciar
pool.connect((err, client, release) => {
  if (err) {
    console.error('❌ Error conectando a PostgreSQL:', err.message);
  } else {
    console.log('✅ Conectado a PostgreSQL (DigitalOcean)');
    release();
  }
});

const app = express();
app.use(express.json());

// Configuración de Whapi Cloud
const WHAPI_BASE_URL = 'https://gate.whapi.cloud';
const WHAPI_TOKEN = process.env.WHAPI_KEY;

// ID del grupo autorizado para consultas
const GRUPO_CONSULTAS_ID = process.env.GRUPO_CONSULTAS_ID;

// ========================================
// FUNCIONES DE BASE DE DATOS
// ========================================

// Validar si es cédula (solo números, 6-10 dígitos)
function esCedula(texto) {
  const regex = /^\d{6,10}$/;
  return regex.test(texto.trim());
}

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

/**
 * Consultar estado completo del paciente en PostgreSQL
 */
async function consultarEstadoPaciente(numeroDocumento) {
  try {
    // 1. Buscar en HistoriaClinica (PostgreSQL)
    const result = await pool.query(`
      SELECT "_id", "primerNombre", "segundoNombre", "primerApellido", "segundoApellido",
             "celular", "empresa", "codEmpresa", "fechaAtencion", "fechaConsulta", "ciudad"
      FROM "HistoriaClinica"
      WHERE "numeroId" = $1
      ORDER BY "fechaAtencion" DESC
      LIMIT 1
    `, [numeroDocumento]);

    if (result.rows.length === 0) {
      return { success: false, message: 'No se encontró información para ese número de documento' };
    }

    const paciente = result.rows[0];
    console.log(`✅ Paciente encontrado para ${numeroDocumento}`);

    const historiaId = paciente._id;
    const nombre = `${paciente.primerNombre || ''} ${paciente.primerApellido || ''}`.trim();
    const ciudad = paciente.ciudad || '';
    const fechaAtencion = paciente.fechaAtencion ? new Date(paciente.fechaAtencion) : null;
    const fechaConsulta = paciente.fechaConsulta ? new Date(paciente.fechaConsulta) : null;
    const ahora = new Date();

    // 2. Buscar en formularios usando wix_id (equivalente a _id de HistoriaClinica)
    let tieneFormulario = false;
    try {
      const formularioResult = await pool.query(`
        SELECT id FROM formularios
        WHERE wix_id = $1
        LIMIT 1
      `, [historiaId]);

      tieneFormulario = formularioResult.rows.length > 0;
      console.log(`🔍 tieneFormulario = ${tieneFormulario}`);
    } catch (error) {
      console.log(`ℹ️ Error consultando formulario para ${numeroDocumento}:`, error.message);
      tieneFormulario = false;
    }

    // 3. Evaluar condiciones (en zona horaria de Colombia)
    let estado = '';
    let estadoDetalle = '';

    // Condición 1: Si tiene fechaConsulta que ya pasó
    if (fechaConsulta && fechaConsulta < ahora) {
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
    // Condición 4: Si tiene fechaAtencion que ya pasó, NO tiene fechaConsulta pero SÍ tiene formulario
    else if (fechaAtencion && fechaAtencion < ahora && !fechaConsulta && tieneFormulario) {
      estado = '⚠️ Realizó link pero no asistió a consulta';
      estadoDetalle = 'no_asistio_consulta';
    }
    // Condición 5: Cita programada pendiente (fechaAtencion >= ahora)
    else if (fechaAtencion && fechaAtencion >= ahora) {
      // Formatear fecha para mostrar
      try {
        const dia = fechaAtencion.toLocaleDateString('es-CO', { day: 'numeric', timeZone: 'America/Bogota' });
        const mes = fechaAtencion.toLocaleDateString('es-CO', { month: 'short', timeZone: 'America/Bogota' });
        const año = fechaAtencion.toLocaleDateString('es-CO', { year: 'numeric', timeZone: 'America/Bogota' });
        const hora = fechaAtencion.toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit', hour12: false, timeZone: 'America/Bogota' });

        estado = `📅 Cita programada: ${dia} ${mes} ${año} ${hora}`;
      } catch (e) {
        // Fallback sin timezone si hay error
        const dia = fechaAtencion.getDate();
        const mes = fechaAtencion.toLocaleDateString('es-CO', { month: 'short' });
        const año = fechaAtencion.getFullYear();
        const hora = fechaAtencion.toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit', hour12: false });

        estado = `📅 Cita programada: ${dia} ${mes} ${año} ${hora}`;
      }
      estadoDetalle = 'cita_programada';
    }
    // Condición 6: Otros casos
    else {
      estado = 'ℹ️ Estado no determinado';
      estadoDetalle = 'indeterminado';
    }

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
    console.error('❌ ERROR en consultarEstadoPaciente:', error.message);
    console.error('❌ ERROR stack:', error.stack);
    return { success: false, message: 'Error al consultar el estado del paciente' };
  }
}

// ========================================
// WEBHOOK - SOLO CONSULTAS EN GRUPO
// ========================================
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

    // Solo procesar mensajes de texto
    if (messageType !== 'text' || !messageText) {
      return res.status(200).json({ status: 'ok', message: 'Not a text message' });
    }

    // Detectar si el mensaje viene de un grupo de WhatsApp
    const isGroupMessage = chatId && chatId.includes('@g.us');

    // Solo procesar mensajes del grupo autorizado
    if (!isGroupMessage || chatId !== GRUPO_CONSULTAS_ID) {
      console.log(`📱 Mensaje ignorado. No es del grupo autorizado.`);
      return res.status(200).json({ status: 'ok', message: 'Not from authorized group' });
    }

    // Ignorar mensajes del bot
    if (message.from_me) {
      return res.status(200).json({ status: 'ok', message: 'Message from bot ignored' });
    }

    console.log(`📱 Mensaje del grupo autorizado de ${from}: ${messageText}`);

    // Verificar si el mensaje es una cédula
    if (esCedula(messageText)) {
      console.log(`🆔 Detectada cédula en grupo: ${messageText}`);

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

    // Ignorar otros mensajes que no sean cédulas
    console.log(`📱 Mensaje ignorado (no es cédula): ${messageText}`);
    return res.status(200).json({ status: 'ok', message: 'Message ignored - not a cedula' });

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
    mode: 'Solo consultas de grupo',
    grupo_id: GRUPO_CONSULTAS_ID || 'No configurado'
  });
});

// Iniciar servidor
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🤖 Bot de WhatsApp corriendo en puerto ${PORT}`);
  console.log(`📱 Webhook URL: http://localhost:${PORT}/webhook`);
  console.log(`💚 Health check: http://localhost:${PORT}/health`);
  console.log(`📱 Grupo autorizado: ${GRUPO_CONSULTAS_ID || 'NO CONFIGURADO'}`);
});
