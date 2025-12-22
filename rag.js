// rag.js - Sistema RAG para el bot de WhatsApp BSL
// Permite que el bot aprenda de conversaciones previas (bot + admin)

const { Pool } = require('pg');
const OpenAI = require('openai');
const crypto = require('crypto');

// Pool de PostgreSQL
const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  ssl: { rejectUnauthorized: false }
});

const openai = new OpenAI({
  apiKey: process.env.OPENAI_KEY,
});

// Modelo de embeddings (text-embedding-3-small es económico y rápido)
const EMBEDDING_MODEL = 'text-embedding-3-small';

/**
 * Genera un embedding para un texto dado
 * @param {string} text - Texto a convertir en embedding
 * @returns {Promise<number[]>} - Vector de embedding (1536 dimensiones)
 */
async function generarEmbedding(text) {
  try {
    const response = await openai.embeddings.create({
      model: EMBEDDING_MODEL,
      input: text.trim().substring(0, 8000), // Limite de tokens
    });
    return response.data[0].embedding;
  } catch (error) {
    console.error('❌ RAG: Error generando embedding:', error.message);
    throw error;
  }
}

/**
 * Genera hash único para evitar duplicados
 */
function generarHash(userId, pregunta, respuesta) {
  const contenido = `${userId}|${pregunta}|${respuesta}`;
  return crypto.createHash('sha256').update(contenido).digest('hex');
}

/**
 * Detecta la categoría de una pregunta usando keywords
 */
function detectarCategoria(texto) {
  const textoLower = texto.toLowerCase();

  const categorias = {
    precios: ['precio', 'costo', 'cuanto', 'valor', 'pago', '$', 'plata', 'tarifa'],
    horarios: ['horario', 'hora', 'cuando', 'disponible', 'abierto', 'atienden'],
    agendamiento: ['agendar', 'cita', 'reservar', 'programar', 'turno', 'agenda'],
    virtual: ['virtual', 'online', 'casa', 'remoto', 'videollamada'],
    presencial: ['presencial', 'ir', 'direccion', 'ubicacion', 'donde', 'sede'],
    certificado: ['certificado', 'descargar', 'pdf', 'listo', 'documento', 'constancia'],
    pagos: ['pagar', 'nequi', 'daviplata', 'bancolombia', 'transferencia', 'comprobante'],
    examenes: ['examen', 'audiometria', 'optometria', 'visiometria', 'medico', 'prueba']
  };

  for (const [categoria, keywords] of Object.entries(categorias)) {
    if (keywords.some(kw => textoLower.includes(kw))) {
      return categoria;
    }
  }
  return 'general';
}

/**
 * Guarda un par pregunta-respuesta con su embedding
 * @param {Object} params - Parámetros del par
 */
async function guardarParConEmbedding({
  userId,
  pregunta,
  respuesta,
  fuente = 'bot',
  timestampOriginal = new Date()
}) {
  try {
    // Validar que haya contenido sustancial
    if (!pregunta || !respuesta || pregunta.length < 3 || respuesta.length < 5) {
      console.log('📭 RAG: Par omitido (contenido muy corto)');
      return { omitido: true };
    }

    // Generar hash para evitar duplicados
    const hash = generarHash(userId, pregunta, respuesta);

    // Verificar si ya existe
    const existente = await pool.query(
      'SELECT id FROM conversacion_embeddings WHERE hash_mensaje = $1',
      [hash]
    );

    if (existente.rows.length > 0) {
      console.log(`📦 RAG: Par ya existe (hash: ${hash.substring(0, 8)}...)`);
      return { duplicado: true, id: existente.rows[0].id };
    }

    // Generar embedding de la pregunta
    const embeddingPregunta = await generarEmbedding(pregunta);

    // Detectar categoría
    const categoria = detectarCategoria(pregunta);

    // Peso según fuente (admin tiene más peso)
    const peso = fuente === 'admin' ? 2.0 : 1.0;

    // Insertar en PostgreSQL
    const result = await pool.query(`
      INSERT INTO conversacion_embeddings (
        user_id, pregunta, respuesta, fuente, peso,
        embedding_pregunta, categoria, timestamp_original, hash_mensaje
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING id
    `, [
      userId,
      pregunta,
      respuesta,
      fuente,
      peso,
      JSON.stringify(embeddingPregunta),
      categoria,
      timestampOriginal,
      hash
    ]);

    console.log(`✅ RAG: Par guardado (id: ${result.rows[0].id}, fuente: ${fuente}, cat: ${categoria})`);
    return { duplicado: false, id: result.rows[0].id };

  } catch (error) {
    console.error('❌ RAG: Error guardando par:', error.message);
    return { error: error.message };
  }
}

/**
 * Busca respuestas similares a una pregunta
 * @param {string} pregunta - Pregunta del usuario
 * @param {Object} options - Opciones de búsqueda
 * @returns {Promise<Array>} - Resultados ordenados por relevancia
 */
async function buscarRespuestasSimilares(pregunta, options = {}) {
  const {
    limite = 3,
    umbralSimilitud = 0.65,
    pesoAdmin = 1.5
  } = options;

  try {
    // Verificar si hay datos suficientes
    const countResult = await pool.query('SELECT COUNT(*) FROM conversacion_embeddings');
    const totalRegistros = parseInt(countResult.rows[0].count);

    if (totalRegistros < 1) {
      console.log('📭 RAG: Sin datos aún para búsqueda');
      return [];
    }

    // Generar embedding de la pregunta
    const embeddingPregunta = await generarEmbedding(pregunta);

    // Query con similitud coseno
    const result = await pool.query(`
      SELECT
        id,
        pregunta,
        respuesta,
        fuente,
        peso,
        categoria,
        veces_usado,
        1 - (embedding_pregunta <=> $1::vector) as similitud
      FROM conversacion_embeddings
      WHERE (1 - (embedding_pregunta <=> $1::vector)) >= $2
      ORDER BY (
        (1 - (embedding_pregunta <=> $1::vector)) * peso *
        CASE WHEN fuente = 'admin' THEN $3 ELSE 1.0 END
      ) DESC
      LIMIT $4
    `, [JSON.stringify(embeddingPregunta), umbralSimilitud, pesoAdmin, limite]);

    // Procesar resultados
    const resultados = result.rows.map(row => ({
      id: row.id,
      pregunta: row.pregunta,
      respuesta: row.respuesta,
      fuente: row.fuente,
      categoria: row.categoria,
      similitud: parseFloat(row.similitud),
      score: parseFloat(row.similitud) * row.peso * (row.fuente === 'admin' ? pesoAdmin : 1.0)
    }));

    // Actualizar contador de uso
    if (resultados.length > 0) {
      const ids = resultados.map(r => r.id);
      await pool.query(`
        UPDATE conversacion_embeddings
        SET veces_usado = veces_usado + 1
        WHERE id = ANY($1)
      `, [ids]);
    }

    console.log(`🔍 RAG: ${resultados.length} resultados para: "${pregunta.substring(0, 40)}..."`);

    return resultados;

  } catch (error) {
    console.error('❌ RAG: Error en búsqueda:', error.message);
    return [];
  }
}

/**
 * Formatea los resultados RAG para incluir en el contexto de OpenAI
 * @param {Array} resultados - Resultados de búsqueda
 * @returns {string} - Texto formateado para el contexto
 */
function formatearContextoRAG(resultados) {
  if (!resultados || resultados.length === 0) {
    return '';
  }

  let contexto = '\n\n--- RESPUESTAS PREVIAS RELEVANTES ---\n';
  contexto += 'Usa estas respuestas como referencia (especialmente las del ADMIN):\n\n';

  resultados.forEach((r, index) => {
    const fuenteLabel = r.fuente === 'admin' ? '👨‍💼 ADMIN' : '🤖 Bot';
    const scorePercent = (r.similitud * 100).toFixed(0);

    contexto += `[${index + 1}] ${fuenteLabel} (${scorePercent}% similar):\n`;
    contexto += `   P: "${r.pregunta.substring(0, 80)}${r.pregunta.length > 80 ? '...' : ''}"\n`;
    contexto += `   R: "${r.respuesta.substring(0, 150)}${r.respuesta.length > 150 ? '...' : ''}"\n\n`;
  });

  contexto += '--- FIN RESPUESTAS PREVIAS ---\n';

  return contexto;
}

module.exports = {
  generarEmbedding,
  guardarParConEmbedding,
  buscarRespuestasSimilares,
  formatearContextoRAG,
  detectarCategoria
};
