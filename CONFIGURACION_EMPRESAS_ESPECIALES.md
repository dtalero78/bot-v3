# Configuración: Empresas con StopBot Automático

## Variable de Entorno

Agregar en `.env`:

```bash
EMPRESAS_STOPBOT_AUTO=SITEL,SIIGO,PARTICULAR
```

## ¿Qué hace?

Cuando un paciente tiene `codEmpresa` que coincide con alguno de los valores en esta lista, el bot automáticamente:

1. Marca `stopBot=true` en la conversación
2. Transfiere inmediatamente al usuario a atención humana
3. NO permite que el bot automático responda

## Casos de uso

- **SITEL**: Cliente corporativo que requiere atención personalizada
- **SIIGO**: Cliente corporativo con procesos especiales
- **PARTICULAR**: Pacientes particulares que prefieren atención humana directa

## Cómo agregar/quitar empresas

1. Editar archivo `.env`
2. Modificar la línea `EMPRESAS_STOPBOT_AUTO`
3. Agregar o quitar códigos separados por comas
4. Reiniciar el servidor para aplicar cambios

**Ejemplo:**
```bash
# Agregar RAPPI
EMPRESAS_STOPBOT_AUTO=SITEL,SIIGO,PARTICULAR,RAPPI

# Quitar SIIGO
EMPRESAS_STOPBOT_AUTO=SITEL,PARTICULAR
```

## Notas técnicas

- **Case-insensitive**: `SITEL`, `sitel`, `Sitel` son equivalentes
- **Sin espacios**: Usar `SITEL,SIIGO` no `SITEL, SIIGO`
- **Campo verificado**: `codEmpresa` en tabla `HistoriaClinica`
- **Activación**: Se aplica en:
  - `buscarPacientePorCelular()` - cuando usuario escribe por primera vez
  - `consultarCita()` - cuando usuario consulta por número de documento

## Logs

Cuando se detecta empresa especial:
```
🔒 Empresa especial detectada: SITEL - Activando stopBot para 3001234567
```

## Verificar configuración actual

Abrir consola de Node.js del servidor:
```javascript
console.log(process.env.EMPRESAS_STOPBOT_AUTO);
// Output: "SITEL,SIIGO,PARTICULAR"
```
