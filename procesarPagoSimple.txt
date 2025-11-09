const { sendMessage } = require('../utils/sendMessage');
const { guardarConversacionEnDB, obtenerConversacionDeDB } = require('../utils/dbAPI');
const { extraerUserId, logInfo, logError } = require('../utils/shared');
const { marcarPagado } = require('../utils/marcarPagado');
const { generarPdfDesdeApi2Pdf } = require('../utils/pdf');
const { sendPdf } = require('../utils/pdf');
const { esCedula } = require('../utils/validaciones');
const { config } = require('../config/environment');

/**
 * FLUJO SÚPER SIMPLE:
 * 1. Imagen -> Pedir documento
 * 2. Documento -> Marcar pagado + Enviar PDF
 */

// Estados simples
const ESTADO_INICIAL = 'inicial';
const ESTADO_ESPERANDO_DOCUMENTO = 'esperando_documento';

/**
 * Procesar imagen - VALIDAR que sea comprobante de pago con OpenAI
 */
async function procesarImagenSimple(message, res) {
    const from = message.from;
    const nombre = message.from_name || "Usuario";
    const userId = extraerUserId(from);
    
    try {
        logInfo('procesarPagoSimple', 'Imagen recibida', { userId });
        
        // 1. Descargar imagen
        const imageId = message.image?.id;
        const mimeType = message.image?.mime_type || "image/jpeg";
        const urlImg = `https://gate.whapi.cloud/media/${imageId}`;
        
        const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
        
        const whapiRes = await fetch(urlImg, {
            method: 'GET',
            headers: { "Authorization": `Bearer ${config.apis.whapi.key}` }
        });

        if (!whapiRes.ok) {
            throw new Error(`Error descargando imagen: ${whapiRes.status}`);
        }

        const arrayBuffer = await whapiRes.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        const base64Image = buffer.toString('base64');
        
        // 2. Validar con OpenAI que sea comprobante de pago
        const { getOpenAIService } = require('../services/openaiService');
        const openaiService = getOpenAIService();
        
        const clasificacion = await openaiService.clasificarImagen(base64Image, mimeType);
        
        if (clasificacion !== "comprobante_pago") {
            const mensaje = `❌ La imagen no parece ser un comprobante de pago válido.\n\nPor favor envía una imagen clara de tu:\n• Comprobante bancario\n• Transferencia\n• Recibo de pago`;
            await sendMessage(from, mensaje);
            return res.json({ success: true, mensaje: "Imagen no válida" });
        }
        
        // 3. Si es comprobante válido, pedir documento
        const mensaje = `✅ *Comprobante de pago recibido*\n\nPara completar el proceso y generar tu certificado, escribe tu *número de documento* (solo números, sin puntos).\n\nEjemplo: 1234567890`;
        
        await sendMessage(from, mensaje);
        
        // 4. Guardar estado
        const conversacion = await obtenerConversacionDeDB(userId);
        const historial = [
            ...conversacion.mensajes,
            {
                from: "usuario",
                mensaje: "📷 (comprobante de pago)",
                timestamp: new Date().toISOString()
            },
            {
                from: "sistema", 
                mensaje: mensaje,
                timestamp: new Date().toISOString()
            }
        ];
        
        await guardarConversacionEnDB({
            userId,
            nombre,
            mensajes: historial,
            nivel: ESTADO_ESPERANDO_DOCUMENTO
        });
        
        logInfo('procesarPagoSimple', 'Comprobante validado - esperando documento', { userId });
        
        return res.json({ success: true, mensaje: "Comprobante validado" });
        
    } catch (error) {
        logError('procesarPagoSimple', 'Error procesando imagen', { userId, error });
        const mensajeError = `❌ No pude procesar tu imagen. Por favor intenta de nuevo con una imagen más clara.`;
        await sendMessage(from, mensajeError);
        return res.status(500).json({ success: false, error: error.message });
    }
}

/**
 * Procesar documento - Marcar pagado y enviar PDF
 */
async function procesarDocumentoSimple(message, res) {
    const from = message.from;
    const nombre = message.from_name || "Usuario";
    const userId = extraerUserId(from);
    const documento = message.text.body.trim();
    
    try {
        logInfo('procesarPagoSimple', 'Procesando documento', { userId, documento });
        
        // 1. Validar que es una cédula
        if (!esCedula(documento)) {
            await sendMessage(from, `❌ Por favor escribe un número de documento válido (solo números).\n\nEjemplo: 1234567890`);
            return res.json({ success: true, mensaje: "Documento inválido" });
        }
        
        // 2. Enviar mensaje de procesamiento
        await sendMessage(from, `⏳ Procesando pago para documento ${documento}...`);
        
        // 3. Marcar como pagado
        const resultadoPago = await marcarPagado(documento);
        
        if (!resultadoPago.success) {
            await sendMessage(from, `❌ No encontré un registro con el documento ${documento}.\n\nVerifica que:\n• El número esté correcto\n• Ya hayas realizado tu examen médico`);
            return res.json({ success: false, mensaje: "Documento no encontrado" });
        }
        
        // 4. Generar y enviar PDF
        try {
            const pdfUrl = await generarPdfDesdeApi2Pdf(documento);
            
            if (pdfUrl) {
                await sendPdf(from, pdfUrl, documento);
                await sendMessage(from, `🎉 *¡Proceso completado exitosamente!*\n\n✅ Pago registrado\n📄 Certificado médico enviado\n✨ Sin marca de agua\n\n¡Gracias por tu pago!`);
            } else {
                await sendMessage(from, `✅ *Pago registrado exitosamente*\n\n⚠️ Hubo un problema generando el PDF. Un asesor te lo enviará pronto.`);
            }
        } catch (pdfError) {
            logError('procesarPagoSimple', 'Error generando PDF', { userId, documento, error: pdfError });
            await sendMessage(from, `✅ *Pago registrado*\n\n⚠️ Error generando certificado. Un asesor te contactará pronto.`);
        }
        
        // 5. Guardar conversación final
        const conversacion = await obtenerConversacionDeDB(userId);
        const historial = [
            ...conversacion.mensajes,
            {
                from: "usuario",
                mensaje: documento,
                timestamp: new Date().toISOString()
            },
            {
                from: "sistema",
                mensaje: "Pago procesado y certificado enviado",
                timestamp: new Date().toISOString()
            }
        ];
        
        await guardarConversacionEnDB({
            userId,
            nombre,
            mensajes: historial,
            nivel: ESTADO_INICIAL // Reset
        });
        
        logInfo('procesarPagoSimple', 'Proceso completado exitosamente', { userId, documento });
        
        return res.json({ success: true, mensaje: "Pago procesado" });
        
    } catch (error) {
        logError('procesarPagoSimple', 'Error procesando documento', { userId, documento, error });
        return res.status(500).json({ success: false, error: error.message });
    }
}

module.exports = {
    procesarImagenSimple,
    procesarDocumentoSimple,
    ESTADO_INICIAL,
    ESTADO_ESPERANDO_DOCUMENTO
};