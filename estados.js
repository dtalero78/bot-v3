/**
 * Estados de Conversación del Bot WhatsApp
 *
 * Sistema de estados para manejar flujos conversacionales de forma explícita
 * en lugar de depender solo del prompt de OpenAI.
 */

const ESTADOS_CONVERSACION = {
  // Estado inicial - usuario acaba de escribir o conversación nueva
  INICIO: 'inicio',

  // Bot mostró las opciones virtual/presencial, esperando que usuario elija
  MOSTRANDO_OPCIONES: 'mostrando_opciones',

  // Usuario eligió virtual/presencial, bot envió link, esperando confirmación de agendamiento
  LINK_ENVIADO: 'link_enviado',

  // Bot pidió número de documento (consulta de cita o pago)
  ESPERANDO_DOCUMENTO: 'esperando_documento',

  // Bot está mostrando información de cita consultada
  CONSULTANDO_CITA: 'consultando_cita',

  // Conversación activa normal (pregunta/respuesta sin flujo específico)
  CONVERSACION_ACTIVA: 'conversacion_activa',

  // Usuario agradece/cierra después de recibir info completa
  CERRANDO_CONVERSACION: 'cerrando_conversacion'
};

/**
 * Palabras que indican que el usuario quiere cerrar la conversación
 */
const PALABRAS_CIERRE = [
  'gracias',
  'muchas gracias',
  'vale',
  'perfecto',
  'ok',
  'entendido',
  'listo',
  'todo claro'
];

/**
 * Palabras que indican elección de examen virtual
 */
const PALABRAS_VIRTUAL = [
  'virtual',
  'quiero virtual',
  'el virtual',
  'voy con virtual',
  'me interesa virtual',
  'prefiero virtual'
];

/**
 * Palabras que indican elección de examen presencial
 */
const PALABRAS_PRESENCIAL = [
  'presencial',
  'quiero presencial',
  'el presencial',
  'voy con presencial',
  'me interesa presencial',
  'prefiero presencial'
];

/**
 * Detecta si el mensaje indica elección de virtual
 */
function esEleccionVirtual(mensaje) {
  const mensajeLower = mensaje.toLowerCase().trim();
  return PALABRAS_VIRTUAL.some(palabra => mensajeLower === palabra || mensajeLower.includes(palabra));
}

/**
 * Detecta si el mensaje indica elección de presencial
 */
function esEleccionPresencial(mensaje) {
  const mensajeLower = mensaje.toLowerCase().trim();
  return PALABRAS_PRESENCIAL.some(palabra => mensajeLower === palabra || mensajeLower.includes(palabra));
}

/**
 * Detecta si el mensaje indica cierre de conversación
 * Solo aplica si el usuario acaba de recibir información completa
 */
function esCierreConversacion(mensaje, estadoActual) {
  // Solo detectar cierre si estamos en estado de consulta o conversación activa
  if (![ESTADOS_CONVERSACION.CONSULTANDO_CITA, ESTADOS_CONVERSACION.CONVERSACION_ACTIVA].includes(estadoActual)) {
    return false;
  }

  const mensajeLower = mensaje.toLowerCase().trim();
  return PALABRAS_CIERRE.some(palabra => mensajeLower === palabra);
}

module.exports = {
  ESTADOS_CONVERSACION,
  PALABRAS_CIERRE,
  PALABRAS_VIRTUAL,
  PALABRAS_PRESENCIAL,
  esEleccionVirtual,
  esEleccionPresencial,
  esCierreConversacion
};
