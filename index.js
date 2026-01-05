require('dotenv').config();
const express = require('express');
const axios = require('axios');
const OpenAI = require('openai');
const { Pool } = require('pg');

// Importar el prompt del sistema
const { systemPrompt } = require('./prompt');

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

// Servir archivos estáticos (dashboard)
app.use(express.static('public'));

// Configurar OpenAI
const openai = new OpenAI({
  apiKey: process.env.OPENAI_KEY,
});

// Configuración de Whapi
const WHAPI_BASE_URL = 'https://gate.whapi.cloud';
const WHAPI_TOKEN = process.env.WHAPI_KEY;

// Número del administrador
const ADMIN_NUMBER = process.env.ADMIN_NUMBER;

// ID del grupo autorizado para consultas de cédula
const GRUPO_CONSULTAS_ID = process.env.GRUPO_CONSULTAS_ID;

// ========================================
// CONFIGURACIÓN DEL BOT CONVERSACIONAL
// ========================================
// NOTA: Sistema DUAL - PostgreSQL (principal) + Wix (sincronización/respaldo)

// ========================================
// FUNCIONES POSTGRESQL - CONVERSACIONES
// ========================================

/**
 * Obtener o crear conversación en PostgreSQL
 * @param {string} celular - Número de celular (formato: 573XXXXXXXXX)
 * @returns {Promise<Object>} - Datos de la conversación
 */
async function getOrCreateConversationPostgres(celular) {
  try {
    // Buscar conversación existente activa
    let result = await pool.query(`
      SELECT id, celular, nombre_paciente, estado, bot_activo, "stopBot",
             wix_whp_id, fecha_ultima_actividad
      FROM conversaciones_whatsapp
      WHERE celular = $1 AND estado != 'cerrada'
      ORDER BY fecha_ultima_actividad DESC
      LIMIT 1
    `, [celular]);

    if (result.rows.length > 0) {
      // Actualizar fecha de última actividad
      await pool.query(`
        UPDATE conversaciones_whatsapp
        SET fecha_ultima_actividad = NOW()
        WHERE id = $1
      `, [result.rows[0].id]);

      console.log(`✅ Conversación PostgreSQL encontrada para ${celular} (id: ${result.rows[0].id})`);
      return result.rows[0];
    }

    // Si no existe, crear nueva conversación
    result = await pool.query(`
      INSERT INTO conversaciones_whatsapp (
        celular, estado, canal, bot_activo, "stopBot",
        fecha_inicio, fecha_ultima_actividad
      ) VALUES ($1, 'nueva', 'bot', true, false, NOW(), NOW())
      RETURNING id, celular, nombre_paciente, estado, bot_activo, "stopBot", wix_whp_id
    `, [celular]);

    console.log(`✅ Nueva conversación PostgreSQL creada para ${celular} (id: ${result.rows[0].id})`);
    return result.rows[0];

  } catch (error) {
    console.error('❌ Error en getOrCreateConversationPostgres:', error.message);
    // Si falla PostgreSQL, retornar valores por defecto
    return {
      id: null,
      celular,
      nombre_paciente: null,
      estado: 'nueva',
      bot_activo: true,
      stopBot: false,
      wix_whp_id: null
    };
  }
}

/**
 * Guardar un mensaje individual en la tabla mensajes_whatsapp
 * @param {number} conversacionId - ID de la conversación
 * @param {string} direccion - 'entrante' o 'saliente'
 * @param {string} contenido - Contenido del mensaje
 * @param {string} tipoMensaje - 'texto', 'imagen', etc.
 * @returns {Promise<boolean>} - Éxito de la operación
 */
async function guardarMensaje(conversacionId, direccion, contenido, tipoMensaje = 'texto') {
  try {
    await pool.query(`
      INSERT INTO mensajes_whatsapp (
        conversacion_id, direccion, contenido, tipo_mensaje, timestamp, leido_por_agente
      ) VALUES ($1, $2, $3, $4, NOW(), false)
    `, [conversacionId, direccion, contenido, tipoMensaje]);

    console.log(`💬 Mensaje guardado: ${direccion} (conversación ${conversacionId})`);
    return true;
  } catch (error) {
    console.error('❌ Error guardando mensaje:', error.message);
    return false;
  }
}

/**
 * Recuperar mensajes del historial de una conversación
 * @param {number} conversacionId - ID de la conversación
 * @param {number} limite - Número máximo de mensajes a recuperar
 * @returns {Promise<Array>} - Array de mensajes
 */
async function recuperarMensajes(conversacionId, limite = 10) {
  try {
    const result = await pool.query(`
      SELECT direccion, contenido, timestamp
      FROM mensajes_whatsapp
      WHERE conversacion_id = $1
      ORDER BY timestamp DESC
      LIMIT $2
    `, [conversacionId, limite]);

    // Invertir para que queden en orden cronológico (más antiguos primero)
    const mensajes = result.rows.reverse().map(msg => ({
      from: msg.direccion === 'entrante' ? 'usuario' : 'bot',
      mensaje: msg.contenido,
      timestamp: msg.timestamp
    }));

    console.log(`📖 Recuperados ${mensajes.length} mensajes de conversación ${conversacionId}`);
    return mensajes;
  } catch (error) {
    console.error('❌ Error recuperando mensajes:', error.message);
    return [];
  }
}

/**
 * Actualizar stopBot en PostgreSQL
 * @param {string} celular - Número de celular
 * @param {boolean} stopBot - Nuevo valor de stopBot
 * @returns {Promise<boolean>} - Éxito de la operación
 */
async function updateStopBotPostgres(celular, stopBot) {
  try {
    const result = await pool.query(`
      UPDATE conversaciones_whatsapp
      SET "stopBot" = $1,
          bot_activo = $2,
          fecha_ultima_actividad = NOW()
      WHERE celular = $3 AND estado != 'cerrada'
      RETURNING id
    `, [stopBot, !stopBot, celular]);

    if (result.rowCount > 0) {
      console.log(`✅ PostgreSQL: stopBot actualizado a ${stopBot} para ${celular}`);
      return true;
    } else {
      console.log(`⚠️ PostgreSQL: No se encontró conversación activa para ${celular}`);
      return false;
    }
  } catch (error) {
    console.error('❌ Error actualizando stopBot en PostgreSQL:', error.message);
    return false;
  }
}

/**
 * Actualizar nombre del paciente en PostgreSQL
 * @param {string} celular - Número de celular
 * @param {string} nombre - Nombre del paciente
 */
async function updateNombrePacientePostgres(celular, nombre) {
  try {
    if (!nombre) return;

    await pool.query(`
      UPDATE conversaciones_whatsapp
      SET nombre_paciente = $1,
          fecha_ultima_actividad = NOW()
      WHERE celular = $2 AND estado != 'cerrada'
    `, [nombre, celular]);

    console.log(`✅ PostgreSQL: Nombre actualizado para ${celular}: ${nombre}`);
  } catch (error) {
    console.error('❌ Error actualizando nombre en PostgreSQL:', error.message);
  }
}

/**
 * OPTIMIZADO: Verificar stopBot de forma eficiente
 * Solo consulta PostgreSQL sin llamadas HTTP ni updates innecesarios
 * Latencia: ~5-10ms vs ~200-500ms del método anterior
 *
 * @param {string} celular - Número de celular
 * @returns {Promise<boolean>} - true si el bot está detenido
 */
async function checkStopBot(celular) {
  try {
    const result = await pool.query(`
      SELECT "stopBot"
      FROM conversaciones_whatsapp
      WHERE celular = $1 AND estado != 'cerrada'
      ORDER BY fecha_ultima_actividad DESC
      LIMIT 1
    `, [celular]);

    if (result.rows.length > 0) {
      return result.rows[0].stopBot === true;
    }

    // Si no existe conversación, bot activo por defecto
    return false;
  } catch (error) {
    console.error('❌ Error verificando stopBot:', error.message);
    // En caso de error, permitir que el bot responda (fail-safe)
    return false;
  }
}

// ========================================
// FUNCIONES DUALES (PostgreSQL + Wix)
// ========================================

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
 * OPTIMIZADO: Obtener conversación SOLO de PostgreSQL
 * Eliminada consulta HTTP a Wix - ya no es necesaria
 *
 * @param {string} userId - Número de celular
 * @returns {Promise<Object>} - Datos de conversación
 */
async function getConversationFromDB(userId) {
  // Obtener/crear en PostgreSQL
  const pgConv = await getOrCreateConversationPostgres(userId);

  // Recuperar últimos 10 mensajes del historial
  const mensajes = await recuperarMensajes(pgConv.id, 10);

  return {
    stopBot: pgConv.stopBot || false,
    mensajes: mensajes, // Mensajes reales del historial
    observaciones: '',
    threadId: '',
    pgConvId: pgConv.id
  };
}

/**
 * OPTIMIZADO: Actualizar stopBot SOLO en PostgreSQL
 * Eliminada sincronización con Wix - ya no es necesaria
 *
 * @param {string} userId - Número de celular
 * @param {boolean} stopBot - Valor de stopBot
 * @returns {Promise<Object>} - Resultado de la operación
 */
async function updateStopBotOnly(userId, stopBot) {
  // Actualizar en PostgreSQL
  const pgSuccess = await updateStopBotPostgres(userId, stopBot);

  console.log(`✅ stopBot actualizado a ${stopBot} para ${userId} (PostgreSQL: ${pgSuccess})`);

  return { success: pgSuccess };
}

/**
 * OPTIMIZADO: Guardar conversación SOLO en PostgreSQL
 * Eliminada sincronización con Wix completamente
 */
async function saveConversationToDB(userId, mensajes, stopBot = false, nombre = '') {
  // Actualizar PostgreSQL
  if (nombre) {
    await updateNombrePacientePostgres(userId, nombre);
  }
  if (stopBot !== undefined) {
    await updateStopBotPostgres(userId, stopBot);
  }

  // Guardar mensajes individuales en mensajes_whatsapp
  const pgConv = await getOrCreateConversationPostgres(userId);

  // Guardar solo los últimos 2 mensajes (último intercambio usuario-bot)
  if (mensajes.length >= 2) {
    const ultimosMensajes = mensajes.slice(-2);

    for (const msg of ultimosMensajes) {
      const direccion = msg.role === 'user' ? 'entrante' : 'saliente';
      const contenido = msg.content;
      await guardarMensaje(pgConv.id, direccion, contenido, 'texto');
    }
  }

  console.log(`💾 Conversación guardada: ${userId} (${mensajes.length} mensajes en memoria, últimos 2 persistidos)`);

  // RAG: Guardar último par pregunta-respuesta para aprendizaje (async, no bloquea)
  guardarEnRAGAsync(userId, mensajes);

  return { success: true };
}

// Función auxiliar para guardar en RAG de forma asíncrona
async function guardarEnRAGAsync(userId, mensajes) {
  try {
    const { guardarParConEmbedding } = require('./rag');

    // Buscar el último par pregunta-respuesta
    if (mensajes.length >= 2) {
      const ultimaPregunta = mensajes[mensajes.length - 2];
      const ultimaRespuesta = mensajes[mensajes.length - 1];

      if (ultimaPregunta.role === 'user' && ultimaRespuesta.role === 'assistant') {
        await guardarParConEmbedding({
          userId,
          pregunta: ultimaPregunta.content,
          respuesta: ultimaRespuesta.content,
          fuente: 'bot',
          timestampOriginal: new Date()
        });
      }
    }
  } catch (error) {
    // Log pero no fallar - RAG es secundario
    console.error('⚠️ RAG: Error guardando (no crítico):', error.message);
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
              text: `Analiza esta imagen y clasifícala. Responde ÚNICAMENTE con una de estas opciones:

1. "comprobante_pago" - Si es un comprobante de pago, transferencia bancaria, recibo de pago, captura de Nequi, Daviplata, Bancolombia, etc.

2. "listado_examenes" - Si es una solicitud de exámenes médicos de una empresa, EPS, o listado de exámenes requeridos.

3. "certificado_medico" - Si es un certificado médico YA EMITIDO, documento con resultados de exámenes, certificado de aptitud laboral, o cualquier documento médico oficial con firmas/sellos.

4. "otra_imagen" - Si es cualquier otra cosa que no coincida con las categorías anteriores.

Responde solo con una de las cuatro opciones, sin explicación adicional.`
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

    if (resultado.includes('comprobante_pago')) {
      return 'comprobante_pago';
    } else if (resultado.includes('listado_examenes')) {
      return 'listado_examenes';
    } else if (resultado.includes('certificado_medico')) {
      return 'certificado_medico';
    } else {
      return 'otra_imagen';
    }
  } catch (error) {
    console.error('Error clasificando imagen:', error);
    return 'error';
  }
}

/**
 * OPTIMIZADO: Buscar paciente por celular en PostgreSQL
 * Eliminada consulta a Wix - usa HistoriaClinica en PostgreSQL
 */
async function buscarPacientePorCelular(celular) {
  try {
    // Limpiar el número: quitar código de país 57 y caracteres no numéricos
    const celularLimpio = celular.replace(/\D/g, '').replace(/^57/, '');

    // Buscar en PostgreSQL
    const result = await pool.query(`
      SELECT "_id", "numeroId", "primerNombre", "primerApellido", "celular",
             "fechaAtencion", "fechaConsulta", "empresa"
      FROM "HistoriaClinica"
      WHERE "celular" = $1
      ORDER BY "fechaAtencion" DESC
      LIMIT 1
    `, [celularLimpio]);

    if (result.rows.length > 0) {
      const paciente = result.rows[0];
      return {
        success: true,
        numeroId: paciente.numeroId,
        nombre: `${paciente.primerNombre || ''} ${paciente.primerApellido || ''}`.trim(),
        celular: paciente.celular,
        fechaAtencion: paciente.fechaAtencion,
        fechaConsulta: paciente.fechaConsulta,
        empresa: paciente.empresa,
        _id: paciente._id
      };
    } else {
      return { success: false, message: 'No se encontró paciente con ese celular' };
    }
  } catch (error) {
    console.error('Error buscando paciente por celular:', error.message);
    return { success: false, message: 'Error al buscar paciente por celular' };
  }
}

/**
 * OPTIMIZADO: Consultar cita SOLO en PostgreSQL
 * Eliminado fallback a Wix - ya no es necesario
 */
async function consultarCita(numeroDocumento) {
  try {
    const result = await pool.query(`
      SELECT "_id", "primerNombre", "segundoNombre", "primerApellido", "segundoApellido",
             "celular", "empresa", "fechaAtencion", "fechaConsulta", "ciudad"
      FROM "HistoriaClinica"
      WHERE "numeroId" = $1
      ORDER BY "fechaAtencion" DESC
      LIMIT 1
    `, [numeroDocumento]);

    if (result.rows.length > 0) {
      const paciente = result.rows[0];
      console.log(`✅ Cita encontrada para ${numeroDocumento}`);
      return {
        success: true,
        paciente: {
          nombre: `${paciente.primerNombre || ''} ${paciente.primerApellido || ''}`.trim(),
          fechaAtencion: paciente.fechaAtencion,
          celular: paciente.celular,
          empresa: paciente.empresa
        }
      };
    }

    return { success: false, message: 'No se encontró información para ese número de documento' };
  } catch (error) {
    console.error('Error consultando cita:', error.message);
    return { success: false, message: 'Error consultando cita' };
  }
}

/**
 * OPTIMIZADO: Consultar estado completo del paciente SOLO en PostgreSQL
 * Eliminados fallbacks a Wix - usa HistoriaClinica y formularios en PostgreSQL
 */
async function consultarEstadoPaciente(numeroDocumento) {
  try {
    // 1. Buscar en HistoriaClinica (PostgreSQL)
    const result = await pool.query(`
      SELECT "_id", "primerNombre", "segundoNombre", "primerApellido", "segundoApellido",
             "celular", "empresa", "fechaAtencion", "fechaConsulta", "ciudad"
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
      console.log(`🔍 tieneFormulario = ${tieneFormulario} (${formularioResult.rows.length} registros)`);
    } catch (error) {
      console.log(`ℹ️ Error consultando formulario para ${numeroDocumento}:`, error.message);
      tieneFormulario = false;
    }

    // 3. Evaluar condiciones (en zona horaria de Colombia)
    console.log(`🔍 DEBUG Antes de evaluar condiciones`);
    console.log(`🔍 DEBUG fechaAtencion:`, fechaAtencion);
    console.log(`🔍 DEBUG fechaConsulta:`, fechaConsulta);
    console.log(`🔍 DEBUG ahora:`, ahora);
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
    console.error('❌ ERROR en consultarEstadoPaciente:', error.message);
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

    console.log(`💰 Usuario ${cedula} marcado como pagado en Wix`);
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

// Marcar como pagado en PostgreSQL (DigitalOcean)
async function marcarPagadoPostgres(cedula) {
  try {
    // Actualizar el registro (las columnas pagado y fecha_pago ya fueron creadas)
    const result = await pool.query(`
      UPDATE "HistoriaClinica"
      SET pagado = TRUE,
          fecha_pago = NOW()
      WHERE "numeroId" = $1
      RETURNING *
    `, [cedula]);

    if (result.rowCount > 0) {
      console.log(`💰 Usuario ${cedula} marcado como pagado en PostgreSQL`);
      return { success: true, data: result.rows[0] };
    } else {
      console.log(`⚠️ No se encontró registro con cédula ${cedula} en PostgreSQL`);
      return { success: false, message: 'Registro no encontrado en PostgreSQL' };
    }
  } catch (error) {
    console.error('❌ Error marcando como pagado en PostgreSQL:', error.message);
    return { success: false, error: error.message };
  }
}

// ========================================
// FIN FUNCIONES PARA FLUJO DE PAGOS
// ========================================

// Función para obtener respuesta de OpenAI (con RAG)
async function getAIResponse(userMessage, conversationHistory = [], contextoPaciente = '') {
  try {
    // Importar funciones RAG
    const { buscarRespuestasSimilares, formatearContextoRAG } = require('./rag');

    // Buscar respuestas similares previas (RAG)
    let contextoRAG = '';
    try {
      const resultadosRAG = await buscarRespuestasSimilares(userMessage, {
        limite: 5,  // Aumentado de 3 a 5 para más contexto
        umbralSimilitud: 0.70,  // Aumentado de 0.65 a 0.70 para mayor precisión
        pesoAdmin: 2.0  // Aumentado de 1.5 a 2.0 para priorizar respuestas del admin
      });

      if (resultadosRAG.length > 0) {
        contextoRAG = formatearContextoRAG(resultadosRAG);
        console.log(`🧠 RAG: Agregando ${resultadosRAG.length} respuestas VERIFICADAS al contexto`);
        console.log(`🔍 RAG: Similitudes: ${resultadosRAG.map(r => (r.similitud * 100).toFixed(0) + '%').join(', ')}`);
      }
    } catch (ragError) {
      console.error('⚠️ RAG: Error (continuando sin RAG):', ragError.message);
    }

    // Construir system prompt enriquecido
    let systemPromptEnriquecido = systemPrompt;
    if (contextoPaciente) {
      systemPromptEnriquecido += contextoPaciente;
    }
    if (contextoRAG) {
      systemPromptEnriquecido += contextoRAG;
    }

    const messages = [
      { role: 'system', content: systemPromptEnriquecido },
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
      } else if (messageText === 'En un momento llegará tu certificado') {
        console.log(`🎯 Comando detectado: detener bot (certificado) para ${userId}`);
        await updateStopBotOnly(userId, true);
        console.log(`🛑 Bot detenido para ${userId} - certificado en proceso`);
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
      } else if (messageText.includes('https://www.bsl.com.co/descargar')) {
        console.log(`🎯 Comando detectado: link de descarga enviado a ${userId}`);
        await updateStopBotOnly(userId, true);
        console.log(`🛑 Bot detenido para ${userId} - link de descarga enviado`);
      } else if (messageText.length > 15) {
        // RAG: Guardar respuesta sustancial del admin para aprendizaje
        console.log(`🧠 RAG: Guardando respuesta del admin para aprendizaje`);
        try {
          const { guardarParConEmbedding } = require('./rag');
          const conversationData = await getConversationFromDB(userId);
          const mensajesUsuario = conversationData.mensajes?.filter(m => m.from === 'usuario') || [];

          if (mensajesUsuario.length > 0) {
            const ultimaPregunta = mensajesUsuario[mensajesUsuario.length - 1].mensaje;
            await guardarParConEmbedding({
              userId,
              pregunta: ultimaPregunta,
              respuesta: messageText,
              fuente: 'admin',
              timestampOriginal: new Date()
            });
            console.log(`✅ RAG: Respuesta de ADMIN guardada (peso 2x)`);
          }
        } catch (ragError) {
          console.error('⚠️ RAG: Error guardando respuesta admin:', ragError.message);
        }
      } else {
        console.log(`⚠️ Mensaje del admin muy corto, no se guarda en RAG`);
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
    // OPTIMIZADO: Solo consulta PostgreSQL sin llamadas HTTP a Wix (~5-10ms vs ~200-500ms)
    if (!isAuthorizedGroup) {
      const isStopBot = await checkStopBot(from);

      if (isStopBot) {
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
          try {
            const dia = fechaAtencion.toLocaleDateString('es-CO', { day: 'numeric', timeZone: 'America/Bogota' });
            const mes = fechaAtencion.toLocaleDateString('es-CO', { month: 'short', timeZone: 'America/Bogota' });
            const año = fechaAtencion.toLocaleDateString('es-CO', { year: 'numeric', timeZone: 'America/Bogota' });
            const hora = fechaAtencion.toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit', hour12: false, timeZone: 'America/Bogota' });

            respuesta = `${estadoPaciente.nombre} - ${dia} ${mes} ${año} ${hora}`;
          } catch (e) {
            // Fallback sin timezone si hay error
            const dia = fechaAtencion.getDate();
            const mes = fechaAtencion.toLocaleDateString('es-CO', { month: 'short' });
            const año = fechaAtencion.getFullYear();
            const hora = fechaAtencion.toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit', hour12: false });

            respuesta = `${estadoPaciente.nombre} - ${dia} ${mes} ${año} ${hora}`;
          }
        }
        // Condición 4: fechaAtencion NO ha pasado + NO tiene FORMULARIO
        else if (fechaAtencion && fechaAtencion >= ahora && !tieneFormulario) {
          respuesta = 'Te falta terminar el formulario. Continúa en este link:\n\nhttps://www.bsl.com.co/desbloqueo';
        }
        // Condición 5: fechaAtencion pasó + NO ha sido atendido (fechaConsulta null)
        else if (fechaAtencion && fechaAtencion < ahora && !fechaConsulta) {
          try {
            const dia = fechaAtencion.toLocaleDateString('es-CO', { day: 'numeric', timeZone: 'America/Bogota' });
            const mes = fechaAtencion.toLocaleDateString('es-CO', { month: 'short', timeZone: 'America/Bogota' });
            const año = fechaAtencion.toLocaleDateString('es-CO', { year: 'numeric', timeZone: 'America/Bogota' });
            const hora = fechaAtencion.toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit', hour12: false, timeZone: 'America/Bogota' });

            respuesta = `Tu cita estaba programada para el ${dia} ${mes} ${año} ${hora}. Un asesor se comunicará contigo para ayudarte.`;
          } catch (e) {
            // Fallback sin timezone si hay error
            const dia = fechaAtencion.getDate();
            const mes = fechaAtencion.toLocaleDateString('es-CO', { month: 'short' });
            const año = fechaAtencion.getFullYear();
            const hora = fechaAtencion.toLocaleTimeString('es-CO', { hour: 'numeric', minute: '2-digit', hour12: false });

            respuesta = `Tu cita estaba programada para el ${dia} ${mes} ${año} ${hora}. Un asesor se comunicará contigo para ayudarte.`;
          }
          debeDetenerBot = true;
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

    // 🔍 BUSCAR AUTOMÁTICAMENTE AL PACIENTE POR SU NÚMERO DE WHATSAPP
    // Esto permite saber en qué punto del flujo está sin pedirle la cédula
    let contextoPaciente = '';
    const pacientePorCelular = await buscarPacientePorCelular(from);

    if (pacientePorCelular.success && pacientePorCelular.numeroId) {
      console.log(`🔍 Paciente identificado por celular: ${pacientePorCelular.nombre} (${pacientePorCelular.numeroId})`);

      // Consultar estado completo del paciente
      const estadoPaciente = await consultarEstadoPaciente(pacientePorCelular.numeroId);

      if (estadoPaciente.success) {
        // Construir contexto para el AI basado en el estado del paciente
        contextoPaciente = `\n\n📋 INFORMACIÓN DEL PACIENTE (identificado automáticamente por su celular):
- Nombre: ${estadoPaciente.nombre}
- Cédula: ${pacientePorCelular.numeroId}
- Empresa: ${pacientePorCelular.empresa || 'No especificada'}
- Estado actual: ${estadoPaciente.estado}
- Estado detallado: ${estadoPaciente.estadoDetalle}
- Tiene formulario diligenciado: ${estadoPaciente.tieneFormulario ? 'Sí' : 'No'}
- Fecha de atención: ${estadoPaciente.fechaAtencion ? new Date(estadoPaciente.fechaAtencion).toLocaleDateString('es-CO') : 'No registrada'}
- Fecha de consulta: ${estadoPaciente.fechaConsulta ? new Date(estadoPaciente.fechaConsulta).toLocaleDateString('es-CO') : 'No realizada'}

IMPORTANTE: Usa el "Estado detallado" para saber exactamente en qué punto está:
- "consulta_realizada" = Ya hizo el examen, puede pagar
- "cita_programada" = Tiene cita pendiente, aún no hace examen
- "falta_formulario" = Falta diligenciar formulario
- "no_realizo_consulta" = No asistió a la cita
- "no_asistio_consulta" = Diligenció formulario pero no fue a consulta`;

        console.log(`📊 Estado del paciente: ${estadoPaciente.estado}`);
      }
    } else {
      console.log(`🔍 No se encontró paciente registrado con celular: ${from}`);
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

    // Obtener respuesta de AI (con contexto del paciente si está disponible)
    const aiResponse = await getAIResponse(messageText, conversationHistory, contextoPaciente);

    // Actualizar historial con el nuevo intercambio
    conversationHistory.push(
      { role: 'user', content: messageText },
      { role: 'assistant', content: aiResponse }
    );

    // Verificar comandos especiales
    if (aiResponse === 'VOLVER_AL_MENU') {
      // Limpiar historial y enviar menú
      await saveConversationToDB(from, [], false, message.from_name || '');
      await sendWhatsAppMessage(from, '🩺 Nuestras opciones:\nVirtual – $52.000 COP\nPresencial – $69.000 COP');
    } else if (aiResponse.includes('AGENDA_COMPLETADA')) {
      // Filtrar comando interno antes de enviar
      const mensajeUsuario = aiResponse.replace('AGENDA_COMPLETADA', '').trim();
      await sendWhatsAppMessage(from, mensajeUsuario);
      await saveConversationToDB(from, conversationHistory, false, message.from_name || '');
    } else if (aiResponse.includes('...transfiriendo con asesor')) {
      // Filtrar marcador de transferencia antes de enviar
      const mensajeUsuario = aiResponse.replace('...transfiriendo con asesor', '').trim();
      await sendWhatsAppMessage(from, mensajeUsuario || 'Un momento por favor.');
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

    // ⚠️ CRÍTICO: Ignorar TODOS los mensajes del bot/admin (texto E imágenes)
    // Esto debe estar ANTES de procesar imágenes para evitar que el admin active flujos de pago
    if (message.from_me) {
      // Caso especial: comando de admin "...dame un momento" para cancelar flujo
      if (from === ADMIN_NUMBER && messageText.includes('...dame un momento')) {
        const userId = chatId.split('@')[0];
        if (estadoPagos.has(userId)) {
          estadoPagos.delete(userId);
          console.log(`🔄 Admin canceló flujo de pago para ${userId}`);
        }
      }

      console.log(`🤖 Mensaje del bot/admin ignorado en webhook-pagos (from: ${from}, type: ${messageType})`);
      return res.status(200).json({ status: 'ok', message: 'Message from bot/admin ignored' });
    }

    // Obtener estado del flujo de pago (en memoria)
    const estadoPago = estadoPagos.get(from);

    // ⚠️ IMPORTANTE: Si es mensaje de texto y NO hay flujo de pago activo, ignorar
    // Este webhook SOLO procesa: imágenes (comprobantes) y documentos después de imagen
    if (messageType === 'text' && !estadoPago) {
      console.log(`📝 Mensaje de texto ignorado en webhook-pagos (sin flujo activo): ${from}`);
      return res.status(200).json({ status: 'ok', message: 'Text message ignored - no payment flow active' });
    }

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
        console.log(`🔍 Clasificación de imagen: ${clasificacion}`);

        // Caso 1: Listado de exámenes médicos
        if (clasificacion === 'listado_examenes') {
          console.log(`📋 Listado de exámenes detectado de ${from}`);

          const mensajeExamenes = `📋 *¡Perfecto! Veo que te pidieron exámenes ocupacionales.*

🩺 *Nuestras opciones:*

*Virtual – $52.000 COP*
• 100% online desde cualquier lugar
• Disponible 7am-7pm todos los días
• Duración: 35 minutos
• Incluye: Médico, audiometría, optometría

*Presencial – $69.000 COP*
• Calle 134 No. 7-83, Bogotá
• Lunes a Viernes 7:30am-4:30pm
• Sábados 8am-11:30am

📲 *Agenda aquí:* https://bsl-plataforma.com/nuevaorden1.html

¿Tienes alguna pregunta sobre los exámenes?`;

          await sendWhatsAppMessage(from, mensajeExamenes);
          return res.status(200).json({ status: 'ok', message: 'Listado de exámenes - información enviada' });
        }

        // Caso 2: Certificado médico (ya emitido) - transferir a asesor
        if (clasificacion === 'certificado_medico') {
          console.log(`📄 Certificado médico detectado de ${from} - transfiriendo a asesor`);

          const mensaje = `...transfiriendo con asesor`;
          await sendWhatsAppMessage(from, mensaje);

          // Marcar stopBot como true para transferir a humano
          await updateStopBotOnly(from, true);

          return res.status(200).json({ status: 'ok', message: 'Certificado médico detectado - transferido a asesor' });
        }

        // Caso 3: Otra imagen (no es pago ni exámenes ni certificado)
        if (clasificacion === 'otra_imagen' || clasificacion === 'error') {
          console.log(`❓ Imagen no reconocida de ${from} - transfiriendo a asesor`);

          const mensaje = `...transfiriendo con asesor`;
          await sendWhatsAppMessage(from, mensaje);

          // Marcar stopBot como true para transferir a humano
          await updateStopBotOnly(from, true);

          return res.status(200).json({ status: 'ok', message: 'Imagen no reconocida - transferido a asesor' });
        }

        // Caso 4: Comprobante de pago válido - pedir documento
        const mensaje = `¿Cual es tu número de documento? (solo números, sin puntos)`;
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
          await sendWhatsAppMessage(from, `¿Cual es tu número de documento? (solo números, sin puntos)`);
          return res.status(200).json({ status: 'ok', message: 'Documento inválido' });
        }

        // 2. Marcar como pagado en Wix
        await sendWhatsAppMessage(from, `⏳ Procesando pago para documento ${documento}...`);

        const resultadoPago = await marcarPagado(documento);

        if (!resultadoPago.success) {
          await sendWhatsAppMessage(from, `❌ No encontré un registro con el documento ${documento}.\n\nVerifica que:\n• El número esté correcto\n• Ya hayas realizado tu examen médico`);
          return res.status(200).json({ status: 'ok', message: 'Documento no encontrado' });
        }

        // 2.1 Marcar como pagado en PostgreSQL (DigitalOcean)
        const resultadoPostgres = await marcarPagadoPostgres(documento);
        if (resultadoPostgres.success) {
          console.log(`✅ Pago sincronizado en PostgreSQL para ${documento}`);
        } else {
          console.log(`⚠️ No se pudo sincronizar en PostgreSQL: ${resultadoPostgres.message || resultadoPostgres.error}`);
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
    persistence: 'PostgreSQL (100% - Sin Wix)',
    version: '2.0 - Optimizado'
  });
});

// ========================================
// ENDPOINTS DE ESTADÍSTICAS RAG
// ========================================

// Endpoint para obtener estadísticas por categoría
app.get('/rag/stats', async (req, res) => {
  try {
    const { obtenerEstadisticasPorCategoria } = require('./rag');

    const { fechaDesde, fechaHasta, fuente } = req.query;

    const stats = await obtenerEstadisticasPorCategoria({
      fechaDesde: fechaDesde || null,
      fechaHasta: fechaHasta || null,
      fuente: fuente || null
    });

    res.status(200).json({
      success: true,
      total: stats.length,
      estadisticas: stats
    });

  } catch (error) {
    console.error('❌ Error obteniendo estadísticas:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Endpoint para buscar por categoría
app.get('/rag/categoria/:categoria', async (req, res) => {
  try {
    const { buscarPorCategoria } = require('./rag');
    const { categoria } = req.params;
    const { limite = 10, fuente } = req.query;

    const resultados = await buscarPorCategoria(categoria, {
      limite: parseInt(limite),
      fuente: fuente || null
    });

    res.status(200).json({
      success: true,
      categoria,
      total: resultados.length,
      conversaciones: resultados
    });

  } catch (error) {
    console.error('❌ Error buscando por categoría:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Endpoint para obtener preguntas frecuentes
app.get('/rag/faq', async (req, res) => {
  try {
    const { obtenerPreguntasFrecuentes } = require('./rag');
    const { categoria, limite = 10 } = req.query;

    const faq = await obtenerPreguntasFrecuentes(
      categoria || null,
      parseInt(limite)
    );

    res.status(200).json({
      success: true,
      total: faq.length,
      preguntas_frecuentes: faq
    });

  } catch (error) {
    console.error('❌ Error obteniendo FAQs:', error.message);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Iniciar servidor
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`🤖 Bot de WhatsApp corriendo en puerto ${PORT}`);
  console.log(`📱 Webhook URL: http://localhost:${PORT}/webhook`);
  console.log(`💚 Health check: http://localhost:${PORT}/health`);
  console.log(`📊 Dashboard RAG: http://localhost:${PORT}/rag-dashboard.html`);
  console.log(`❓ FAQ: http://localhost:${PORT}/rag-faq.html`);
  console.log(`📈 API Stats: http://localhost:${PORT}/rag/stats`);
});
