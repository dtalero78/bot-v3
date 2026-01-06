-- Migration: Agregar estado de conversación
-- Fecha: 2026-01-06
-- Descripción: Agrega columna para trackear el estado actual de cada conversación

-- Agregar columna estado_actual
ALTER TABLE conversaciones_whatsapp
ADD COLUMN IF NOT EXISTS estado_actual VARCHAR(50) DEFAULT 'inicio';

-- Crear índice para mejorar queries por estado
CREATE INDEX IF NOT EXISTS idx_conversaciones_estado
ON conversaciones_whatsapp(estado_actual);

-- Comentario en la columna
COMMENT ON COLUMN conversaciones_whatsapp.estado_actual IS
'Estado actual de la conversación: inicio, mostrando_opciones, esperando_eleccion, link_enviado, esperando_documento, consultando_cita, cerrando_conversacion';
