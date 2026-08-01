# NEON BREACH

Shooter en primera persona en el navegador. Arena neón, oleadas infinitas de
criminales futuristas y un arsenal que hay que buscarse por el mapa. Hecho con
Three.js, sin build step y sin assets externos: la geometría, las texturas, los
personajes y los sonidos se generan en tiempo de ejecución.

## Jugar

Necesita servirse por HTTP (los módulos ES no cargan desde `file://`):

```bash
python -m http.server 8123
```

Y abre <http://localhost:8123>.

## Controles

| Tecla | Acción |
|---|---|
| `WASD` | Moverse |
| Ratón | Apuntar |
| Click izq. | Disparar (mantén pulsado en las automáticas) |
| `1` / `2` | Pistola / arma recogida |
| `R` | Recargar (sólo la pistola) |
| `F` | Cámara lenta |
| `Shift` | Sprint |
| `Espacio` | Saltar |
| `Esc` | Pausa |

## Armas

La pistola es tu arma fija: floja pero con munición infinita y cargador de 12.
El resto se recoge en los pedestales repartidos por la arena, trae muy pocas
balas, y al gastarse vuelves automáticamente a la pistola. Los pedestales
reaparecen a los 25 segundos.

| Arma | Daño | Cadencia | Balas | Notas |
|---|---|---|---|---|
| Pistola | 15 | Semi | 12 (∞) | Siempre disponible, se recarga con `R` |
| Escopeta | 15 ×9 | Semi | 5 | Nueve perdigones, demoledora de cerca |
| Railgun | 130 | Lenta | 3 | Atraviesa a todos los enemigos en línea |
| Plasma | 19 | Auto | 22 | Muy rápida, ideal contra grupos |

**Los disparos a la cabeza hacen el doble de daño y dan el doble de puntos.**

## Enemigos

| Tipo | Color | Vida | Arma | Comportamiento | Puntos |
|---|---|---|---|---|---|
| Thug | Magenta | 45 | Porra eléctrica | Va a por ti cuerpo a cuerpo | 100 |
| Runner | Cian | 22 | Cuchillo | Rápido y frágil, te desborda | 150 |
| Gunner | Lima | 34 | Rifle | Mantiene 15 m y dispara proyectiles esquivables | 220 |
| Brute | Naranja | 125 | Mazo | Lento y muy duro, pega fortísimo | 320 |

Todos suben rampas y cajas persiguiéndote, así que ningún sitio del mapa es
seguro por altura.

Los gunners aparecen a partir de la oleada 2 y los brutes de la 4. Al morir
sueltan orbes: verde cura 25 PV, morado recarga media barra de cámara lenta.

## Cámara lenta

`F` activa el bullet time: el mundo baja al 30 % de velocidad y tú al 62 %,
mientras que apuntar sigue a velocidad normal. Consume una barra de energía que
da para unos 3 segundos y tarda 12 en llenarse sola. Por debajo del 22 % no se
puede reactivar.

## Estructura

- `index.html` — HUD, overlays e *import map* de Three.js (desde unpkg).
- `style.css` — estética synthwave del HUD y los menús.
- `main.js` — todo el juego: arena, física, personajes, IA, armas, partículas,
  oleadas y audio.

## El mapa

Arena de 104×104 m con plataforma central elevada y rampas, cuatro reductos en
las esquinas, escaleras de cajas y pilares que cortan las líneas de tiro. Las
alturas están escalonadas: un salto sube una caja de 1,15 m, los bordes de menos
de 0,65 m se suben andando, y toda azotea es alcanzable encadenando cajas o
subiendo una rampa.

### Detalles de implementación

- **Rig humanoide compartido** (`buildHumanoid`): un único constructor genera
  tanto tu cuerpo en primera persona como los cuatro enemigos — torso cónico,
  cabeza y articulaciones esféricas, y brazos y piernas de dos segmentos que
  doblan por codo y rodilla. La geometría se cachea por silueta y se comparte
  entre todas las instancias de un tipo; sólo los materiales son por personaje,
  para poder hacer parpadear a uno al recibir un impacto.
- **Colisión con cajas AABB**: las rampas no tienen volumen propio, se aproximan
  con una escalera de peldaños más bajos que el asistente de escalón, de modo
  que todo el mundo (jugador y enemigos) las sube andando.
- **Arma en cámara propia**: el viewmodel se renderiza en una capa aparte con su
  propio `PerspectiveCamera` a 55° y limpieza de profundidad, para que no se
  deforme con el FOV de 78° del mundo ni lo recorte tu propio torso.
- **Cuerpo en primera persona**: sigue tu posición y el *yaw* pero nunca el
  *pitch*, y va ligeramente adelantado respecto al ojo para que se vea al mirar
  hacia abajo.
- **Simulación separada del render**: `step(dt)` avanza un tick de juego y
  `animate()` sólo lo conduce, así el mundo se puede simular de forma
  determinista al margen de los frames.

## Ajustes rápidos

Las constantes del principio de `main.js` controlan el balance: `WEAPONS`,
`ENEMY_TYPES`, `SLOW` (cámara lenta) y `ARENA` / `WALK` / `SPRINT` / `GRAVITY`
para el movimiento. La intensidad del brillo está en el `UnrealBloomPass`.
