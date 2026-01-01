# Análisis y Optimizaciones del Prompt del Bot BSL

## Resumen Ejecutivo

Después de analizar `prompt.js` e `index.js`, he identificado **oportunidades de optimización** en el prompt del sistema para:
1. Reducir tokens enviados a OpenAI
2. Mejorar precisión de respuestas
3. Hacer el flujo más eficiente
4. Reducir costos de API

---

## 1. Análisis del Prompt Actual

### Estadísticas
- **Longitud**: ~2,700 caracteres (~675 tokens aprox.)
- **Estructura**: Instrucciones generales + contexto dinámico del paciente
- **Uso**: Se envía en CADA mensaje del usuario
- **Costo**: ~$0.00034 por mensaje (gpt-4o-mini)

### Fortalezas ✅
- Muy detallado y específico
- Cubre todos los casos de uso
- Instrucciones claras sobre comandos especiales
- Buen manejo de "Estado detallado"

### Debilidades ⚠️
- **Repetitivo**: Incluye información que no cambia (precios, links, datos legales)
- **Largo**: ~675 tokens por cada mensaje
- **No aprovecha caché**: GPT-4o-mini no cachea el system prompt
- **Información estática duplicada**: Precios y links se envían siempre aunque no se usen

---

## 2. Problemas Identificados

### Problema 1: Información Estática Repetida
```javascript
// Esto se envía en CADA mensaje, incluso si el usuario solo dice "hola"
**Exámenes Ocupacionales:**
• Virtual: $46.000 COP (7am-7pm, todos los días, 35 min total)
• Presencial: $69.000 COP (Calle 134 No. 7-83, Bogotá)
...
// 40 líneas de información que pocas veces se usa
```

**Impacto:**
- ~400 tokens desperdiciados en mensajes simples
- Costo innecesario: ~$0.0002 por mensaje simple
- Latencia adicional: ~100-200ms

### Problema 2: Contexto del Paciente Siempre Se Genera
```javascript
// En index.js línea 1074-1100
// SIEMPRE se busca paciente y se construye contexto, incluso si no se necesita
const pacientePorCelular = await buscarPacientePorCelular(from);
if (pacientePorCelular.success) {
  const estadoPaciente = await consultarEstadoPaciente(numeroId);
  contextoPaciente = `...mucho texto...`; // ~200 tokens
}
```

**Impacto:**
- 2 queries a Wix por cada mensaje (buscarPacientePorCelular + consultarEstadoPaciente)
- ~200-400ms de latencia adicional
- Contexto generado aunque usuario solo diga "gracias" o "ok"

### Problema 3: No Usa RAG Eficientemente
```javascript
// En index.js línea 762
if (contextoRAG) {
  systemPromptEnriquecido += contextoRAG;
}
```

El RAG se agrega AL FINAL del prompt, cuando debería estar más cerca de las instrucciones de comportamiento.

### Problema 4: Instrucciones Redundantes
```javascript
// Línea 4-7
- NUNCA te presentes como BSL si ya estás en una conversación activa
- Responde en frases cortas y claras, sin tecnicismos
- Si el usuario ya recibió información específica, NO la repitas automáticamente
- Mantén el contexto de la conversación
```

Esto podría expresarse más concisamente sin perder claridad.

---

## 3. Optimizaciones Propuestas

### Optimización 1: Prompt Dinámico por Tipo de Consulta

**ANTES (Actual):**
```javascript
// TODO el prompt se envía siempre
const systemPromptEnriquecido = systemPrompt + contextoPaciente + contextoRAG;
```

**DESPUÉS (Propuesto):**
```javascript
// Solo incluir secciones relevantes según el contexto
function buildPrompt(messageType, hasPatientInfo, needsPricing) {
  let prompt = CORE_INSTRUCTIONS; // ~100 tokens

  if (needsPricing) {
    prompt += PRICING_INFO; // ~150 tokens
  }

  if (hasPatientInfo) {
    prompt += patientContext; // ~200 tokens
  }

  if (contextoRAG) {
    prompt += contextoRAG; // variable
  }

  return prompt;
}
```

**Ahorro:** 40-60% de tokens en mensajes simples

### Optimización 2: Lazy Loading de Contexto del Paciente

**ANTES (Actual):**
```javascript
// SIEMPRE busca paciente
const pacientePorCelular = await buscarPacientePorCelular(from);
const estadoPaciente = await consultarEstadoPaciente(numeroId);
contextoPaciente = `...`;
```

**DESPUÉS (Propuesto):**
```javascript
// Solo buscar paciente cuando es necesario
function needsPatientContext(message) {
  const keywords = ['certificado', 'pago', 'cita', 'horario', 'documento', 'examen'];
  return keywords.some(k => message.toLowerCase().includes(k));
}

let contextoPaciente = '';
if (needsPatientContext(messageText)) {
  const pacientePorCelular = await buscarPacientePorCelular(from);
  // ... construir contexto
}
```

**Ahorro:** 2 queries HTTP en ~60% de mensajes simples ("hola", "gracias", "ok")

### Optimización 3: Prompt Base Más Compacto

**ANTES:**
```javascript
const systemPrompt = `Eres el asistente virtual de BSL para exámenes médicos ocupacionales en Colombia.

🎯 REGLAS FUNDAMENTALES:
- NUNCA te presentes como BSL si ya estás en una conversación activa
- Responde en frases cortas y claras, sin tecnicismos
- Si el usuario ya recibió información específica, NO la repitas automáticamente
- Mantén el contexto de la conversación
...
[2,700 caracteres más]
`;
```

**DESPUÉS:**
```javascript
const CORE_PROMPT = `Asistente BSL - Exámenes médicos ocupacionales Colombia.

REGLAS:
- Conversación continua (no repetir presentación)
- Respuestas cortas y claras
- Mantener contexto

COMANDOS:
- "...transfiriendo con asesor" → detiene bot
- "VOLVER_AL_MENU" → reset conversación
- "AGENDA_COMPLETADA" → confirma agendamiento

FUERA DE ALCANCE:
Temas personales/emocionales → "Solo ayudo con exámenes médicos ocupacionales"
`;

const PRICING_INFO = `
SERVICIOS:
• Virtual: $46.000 (7am-7pm, 35min)
• Presencial: $69.000 (Calle 134 #7-83, Bogotá)
Incluye: médico, audiometría, optometría

EXTRAS:
• Cardiovascular/Vascular/Espirometría/Dermato: $5.000 c/u
• Psicológico: $15.000
• Perfil lipídico: $60.000
• Glicemia: $20.000

PAGO: Bancolombia 44291192456, Daviplata 3014400818, Nequi 3008021701

AGENDA: https://bsl-plataforma.com/nuevaorden1.html
`;

const PATIENT_FLOW_INSTRUCTIONS = `
ESTADOS DEL PACIENTE:
- consulta_realizada: examen completo → "Envía comprobante de pago"
- cita_programada: cita pendiente → "Primero realiza tu examen"
- falta_formulario: → "Completa formulario: bsl.com.co/desbloqueo"
- no_realizo_consulta/no_asistio_consulta: → transferir asesor
`;
```

**Ahorro:** ~30% de tokens manteniendo la misma funcionalidad

### Optimización 4: Caché de Preguntas Frecuentes

**Nuevo:**
```javascript
// Cache en memoria para respuestas frecuentes
const FAQ_CACHE = {
  'precio virtual': 'Virtual: $46.000 COP',
  'precio presencial': 'Presencial: $69.000 COP',
  'horarios': '7am-7pm todos los días',
  'link agenda': 'https://bsl-plataforma.com/nuevaorden1.html',
  // ... más FAQs
};

function checkFAQ(message) {
  const normalized = message.toLowerCase().trim();
  for (const [key, value] of Object.entries(FAQ_CACHE)) {
    if (normalized.includes(key)) {
      return value;
    }
  }
  return null;
}

// En el webhook
const faqResponse = checkFAQ(messageText);
if (faqResponse) {
  await sendWhatsAppMessage(from, faqResponse);
  return res.status(200).json({ status: 'ok', message: 'FAQ response sent' });
}
```

**Ahorro:** Evita llamada a OpenAI (~$0.0003) en preguntas muy comunes

---

## 4. Implementación Propuesta

### Archivo: `prompt-optimizado.js`

```javascript
// Prompt base compacto (siempre se incluye)
const CORE_PROMPT = `Asistente BSL - Exámenes médicos ocupacionales Colombia.

REGLAS: Conversación continua, respuestas cortas, mantener contexto.

COMANDOS ESPECIALES:
- "...transfiriendo con asesor" → detiene bot
- "VOLVER_AL_MENU" → reset
- "AGENDA_COMPLETADA" → confirma agendamiento

FUERA DE ALCANCE: Temas personales → "Solo ayudo con exámenes médicos ocupacionales"`;

// Información de precios (solo cuando se necesita)
const PRICING_MODULE = `

SERVICIOS:
• Virtual: $46.000 (7am-7pm, 35min, online) - https://bsl-plataforma.com/nuevaorden1.html
• Presencial: $69.000 (Calle 134 #7-83, Bogotá)
Incluyen: médico osteomuscular, audiometría, optometría

EXTRAS OPCIONALES:
• Cardiovascular/Vascular/Espirometría/Dermato: $5.000 c/u
• Psicológico: $15.000
• Perfil lipídico: $60.000, Glicemia: $20.000

PAGO: Bancolombia 44291192456, Daviplata 3014400818, Nequi 3008021701

IMPORTANTE: Osteomuscular SOLO en paquete completo ($46.000), no separado.`;

// Instrucciones de flujo de paciente (solo cuando hay info de paciente)
const PATIENT_FLOW_MODULE = `

FLUJO SEGÚN ESTADO:
1. consulta_realizada: Examen completo → "Envía comprobante de pago para liberar certificado"
2. cita_programada: Cita pendiente → "Primero realiza tu examen programado"
3. falta_formulario: → "Completa formulario: https://www.bsl.com.co/desbloqueo"
4. no_realizo_consulta/no_asistio_consulta: → "...transfiriendo con asesor"

IMPORTANTE: Usa "Estado detallado" para saber qué responder sobre pagos/certificados.`;

// Respuestas contextuales (solo para saludos)
const GREETING_MODULE = `

SALUDOS SEGÚN ESTADO:
- consulta_realizada: "¡Hola! Tu certificado está listo. ¿Necesitas descargarlo?"
- cita_programada: "¡Hola! Tienes cita programada. ¿En qué ayudo?"
- falta_formulario: "¡Hola! Te falta completar el formulario. ¿Necesitas ayuda?"
- Sin info: "¡Hola! ¿En qué puedo ayudarte?"`;

// Datos legales (solo cuando se pregunta)
const LEGAL_MODULE = `

DATOS LEGALES BSL:
NIT: 900.844.030-8
LICENCIA: Resolución No 64 de 10/01/2017
CÓDIGO PRESTADOR REPS: 1100130342
DISTINTIVO: DHSS0244914
Consulta: https://prestadores.minsalud.gov.co/habilitacion/`;

/**
 * Construye el prompt dinámicamente según el contexto
 */
function buildOptimizedPrompt(options = {}) {
  const {
    needsPricing = false,
    hasPatientInfo = false,
    isGreeting = false,
    needsLegal = false,
    patientContext = '',
    ragContext = ''
  } = options;

  let prompt = CORE_PROMPT;

  if (isGreeting && hasPatientInfo) {
    prompt += GREETING_MODULE;
  }

  if (needsPricing) {
    prompt += PRICING_MODULE;
  }

  if (hasPatientInfo) {
    prompt += PATIENT_FLOW_MODULE;
    if (patientContext) {
      prompt += `\n\n${patientContext}`;
    }
  }

  if (needsLegal) {
    prompt += LEGAL_MODULE;
  }

  if (ragContext) {
    prompt += `\n\nCONOCIMIENTO ADICIONAL:\n${ragContext}`;
  }

  return prompt;
}

/**
 * Detecta qué módulos necesita el mensaje
 */
function analyzeMessageNeeds(message) {
  const msg = message.toLowerCase();

  return {
    needsPricing: /precio|costo|valor|pago|cuanto|cuánto|virtual|presencial/.test(msg),
    isGreeting: /^(hola|buenos|buenas|buen|qué|que tal|hey|alo|saludos)/i.test(msg),
    needsLegal: /licencia|habilitacion|habilitación|nit|reps|legal|permiso/.test(msg),
    needsPatient: /certificado|pago|cita|horario|documento|examen|consulta|agendar/.test(msg)
  };
}

module.exports = {
  buildOptimizedPrompt,
  analyzeMessageNeeds,
  CORE_PROMPT,
  PRICING_MODULE,
  PATIENT_FLOW_MODULE,
  GREETING_MODULE,
  LEGAL_MODULE
};
```

### Modificación en `index.js`:

```javascript
// Reemplazar getAIResponse (línea ~733)
const { buildOptimizedPrompt, analyzeMessageNeeds } = require('./prompt-optimizado');

async function getAIResponse(userMessage, conversationHistory = [], contextoPaciente = '') {
  try {
    // Analizar qué necesita el mensaje
    const needs = analyzeMessageNeeds(userMessage);

    // Buscar contexto RAG
    let contextoRAG = '';
    try {
      const { buscarContextoRAG } = require('./rag');
      contextoRAG = await buscarContextoRAG(userMessage);
    } catch (error) {
      console.log('ℹ️ RAG no disponible');
    }

    // Construir prompt optimizado
    const systemPromptOptimizado = buildOptimizedPrompt({
      needsPricing: needs.needsPricing,
      hasPatientInfo: contextoPaciente !== '',
      isGreeting: needs.isGreeting,
      needsLegal: needs.needsLegal,
      patientContext: contextoPaciente,
      ragContext: contextoRAG
    });

    console.log(`📊 Prompt size: ${systemPromptOptimizado.length} chars (~${Math.ceil(systemPromptOptimizado.length / 4)} tokens)`);

    const messages = [
      { role: 'system', content: systemPromptOptimizado },
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
    console.error('Error obteniendo respuesta de AI:', error.message);
    return 'Lo siento, tuve un problema técnico. Por favor intenta de nuevo.';
  }
}
```

### Modificación en webhook (línea ~1074):

```javascript
// ANTES: Siempre busca paciente
const pacientePorCelular = await buscarPacientePorCelular(from);

// DESPUÉS: Solo buscar si es necesario
const needs = analyzeMessageNeeds(messageText);
let contextoPaciente = '';

if (needs.needsPatient || needs.isGreeting) {
  const pacientePorCelular = await buscarPacientePorCelular(from);

  if (pacientePorCelular.success && pacientePorCelular.numeroId) {
    const estadoPaciente = await consultarEstadoPaciente(pacientePorCelular.numeroId);

    if (estadoPaciente.success) {
      contextoPaciente = `
📋 PACIENTE: ${estadoPaciente.nombre} (${pacientePorCelular.numeroId})
Estado: ${estadoPaciente.estadoDetalle}
Formulario: ${estadoPaciente.tieneFormulario ? 'Sí' : 'No'}
${estadoPaciente.fechaAtencion ? `Fecha atención: ${new Date(estadoPaciente.fechaAtencion).toLocaleDateString('es-CO')}` : ''}`;
    }
  }
}
```

---

## 5. Estimación de Mejoras

### Reducción de Tokens

| Escenario | Tokens Antes | Tokens Después | Reducción |
|-----------|--------------|----------------|-----------|
| Mensaje simple ("hola") | ~675 | ~150 | 78% |
| Pregunta precio | ~675 | ~400 | 41% |
| Consulta con paciente | ~875 | ~550 | 37% |
| **Promedio** | **~742** | **~367** | **~51%** |

### Reducción de Latencia

| Componente | Antes | Después | Mejora |
|------------|-------|---------|--------|
| Buscar paciente (HTTP) | 200-400ms | 0ms (lazy) | 100% en msgs simples |
| Consultar estado (HTTP) | 200-400ms | 0ms (lazy) | 100% en msgs simples |
| OpenAI processing | 300-500ms | 200-350ms | ~30% (menos tokens) |
| **Total mensaje simple** | **700-1300ms** | **200-350ms** | **~70%** |

### Reducción de Costos

**Costo por 1,000 mensajes:**

| Tipo | Antes | Después | Ahorro |
|------|-------|---------|--------|
| Mensajes simples (60%) | $0.20 | $0.05 | 75% |
| Preguntas precio (25%) | $0.23 | $0.13 | 43% |
| Consultas paciente (15%) | $0.26 | $0.17 | 35% |
| **TOTAL** | **$0.22** | **$0.10** | **~55%** |

**Ahorro anual** (estimando 10,000 mensajes/mes):
- Antes: $26.40/año
- Después: $12.00/año
- **Ahorro: $14.40/año** (~55%)

---

## 6. FAQ Cache - Implementación

```javascript
// En index.js, ANTES de llamar a OpenAI

const FAQ_RESPONSES = {
  // Precios
  'precio virtual': '🩺 Examen Virtual: $46.000 COP\n📍 100% online\n⏰ 7am-7pm todos los días\n⏱️ 35 minutos\n\nAgenda: https://bsl-plataforma.com/nuevaorden1.html',
  'precio presencial': '🏥 Examen Presencial: $69.000 COP\n📍 Calle 134 No. 7-83, Bogotá\n⏰ Según disponibilidad\n\nAgenda: https://bsl-plataforma.com/nuevaorden1.html',

  // Links
  'link': 'Agenda aquí: https://bsl-plataforma.com/nuevaorden1.html',
  'agendar': 'Agenda tu examen: https://bsl-plataforma.com/nuevaorden1.html',

  // Horarios
  'horario': 'Exámenes virtuales: 7am-7pm todos los días\nExámenes presenciales: Según disponibilidad',

  // Dirección
  'direccion': '📍 Calle 134 No. 7-83, Bogotá',
  'donde': '📍 Calle 134 No. 7-83, Bogotá',

  // Pago
  'pagar': 'Medios de pago:\n💳 Bancolombia: 44291192456\n📱 Daviplata: 3014400818\n📱 Nequi: 3008021701\n💸 Transfiya'
};

function checkFAQ(message) {
  const msg = message.toLowerCase().trim();

  // Buscar coincidencias exactas o parciales
  for (const [keyword, response] of Object.entries(FAQ_RESPONSES)) {
    if (msg.includes(keyword)) {
      return response;
    }
  }

  return null;
}

// En el webhook, después de verificar stopBot:
const faqResponse = checkFAQ(messageText);
if (faqResponse) {
  console.log(`💡 FAQ response for: "${messageText}"`);
  await sendWhatsAppMessage(from, faqResponse);

  // Guardar en historial
  await saveConversationToDB(from, [
    { role: 'user', content: messageText },
    { role: 'assistant', content: faqResponse }
  ], false, message.from_name || '');

  return res.status(200).json({ status: 'ok', message: 'FAQ sent' });
}
```

---

## 7. Plan de Implementación

### Fase 1: Optimización Básica (1-2 horas)
1. ✅ Crear `prompt-optimizado.js` con módulos separados
2. ✅ Implementar `buildOptimizedPrompt()`
3. ✅ Modificar `getAIResponse()` para usar nuevo prompt
4. ✅ Testear con mensajes simples

**Resultado esperado:** ~40% reducción de tokens en mensajes simples

### Fase 2: Lazy Loading (30 min)
1. ✅ Implementar `analyzeMessageNeeds()`
2. ✅ Modificar webhook para buscar paciente solo cuando necesario
3. ✅ Testear con diferentes tipos de mensajes

**Resultado esperado:** ~50% reducción en queries HTTP

### Fase 3: FAQ Cache (30 min)
1. ✅ Implementar `checkFAQ()` con respuestas predefinidas
2. ✅ Agregar verificación ANTES de llamar OpenAI
3. ✅ Testear con preguntas frecuentes

**Resultado esperado:** ~20% mensajes resueltos sin OpenAI

### Fase 4: Monitoreo y Ajuste (ongoing)
1. ✅ Agregar logs de tamaño de prompt
2. ✅ Medir latencia antes/después
3. ✅ Ajustar keywords de FAQ según uso real

---

## 8. Métricas a Monitorear

### Antes de Optimizar
```bash
# Crear baseline
grep "Prompt size" logs.txt | awk '{sum+=$4; count++} END {print "Avg:", sum/count}'
grep "OpenAI latency" logs.txt | awk '{sum+=$4; count++} END {print "Avg:", sum/count, "ms"}'
```

### Después de Optimizar
```bash
# Comparar mejoras
grep "FAQ response" logs.txt | wc -l  # Cuántos mensajes se resolvieron sin OpenAI
grep "Prompt size.*~[0-9]+ tokens" logs.txt  # Tamaño de prompts
```

### KPIs Objetivo
- ✅ Reducción de tokens: >40%
- ✅ Reducción de latencia: >50% en mensajes simples
- ✅ Reducción de costos: >45%
- ✅ FAQ hit rate: >15%

---

## 9. Riesgos y Mitigación

### Riesgo 1: Pérdida de Contexto
**Mitigación:** Mantener CORE_PROMPT con instrucciones esenciales siempre

### Riesgo 2: Respuestas Menos Precisas
**Mitigación:** Testear extensivamente antes de desplegar, A/B testing

### Riesgo 3: FAQ Responses Incorrectos
**Mitigación:** Revisar keywords cuidadosamente, logging de FAQ hits

---

## 10. Conclusiones y Recomendaciones

### ✅ Implementar YA
1. **Prompt modular**: Reducción inmediata de ~40% tokens
2. **Lazy loading de paciente**: Ahorro de ~50% queries HTTP
3. **FAQ cache**: ~15-20% mensajes sin OpenAI

### ⏳ Implementar Después (Opcional)
1. **A/B testing**: Comparar respuestas optimizadas vs originales
2. **Analytics**: Dashboard de uso de módulos
3. **Dynamic pricing**: Actualizar precios desde BD en lugar de hardcoded

### 📊 Impacto Estimado Total
- **Tokens**: -51% promedio
- **Latencia**: -70% en mensajes simples, -30% en complejos
- **Costos**: -55% anual (~$14.40/año)
- **Queries HTTP**: -50% a Wix

### 🎯 Prioridad
**ALTA** - La optimización es recomendada porque:
1. Bajo esfuerzo de implementación (3-4 horas)
2. Alto impacto en rendimiento y costos
3. Sin breaking changes (compatible con sistema actual)
4. Mejora experiencia de usuario (respuestas más rápidas)
