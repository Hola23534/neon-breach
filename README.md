# NEON BREACH

Shooter en primera persona en el navegador. Arena neón, oleadas infinitas de enemigos
y un rifle que no perdona. Hecho con Three.js, sin build step y sin assets externos:
la geometría, las texturas y los sonidos se generan en tiempo de ejecución.

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
| Click izq. | Disparar (mantén pulsado para automático) |
| `R` | Recargar |
| `Shift` | Sprint |
| `Espacio` | Saltar |
| `Esc` | Pausa |

## Enemigos

| Tipo | Color | Vida | Velocidad | Daño | Puntos |
|---|---|---|---|---|---|
| Grunt | Magenta | 40 | Media | 12 | 100 |
| Swift | Cian | 22 | Alta | 8 | 150 |
| Brute | Naranja | 150 | Baja | 26 | 320 |

Cada oleada añade enemigos y, a partir de la 2ª y la 4ª, empiezan a aparecer swifts y
brutes. Al morir sueltan orbes: verde cura 25 PV, cian da 45 balas.

## Estructura

- `index.html` — HUD, overlays e *import map* de Three.js (desde unpkg).
- `style.css` — estética synthwave del HUD y los menús.
- `main.js` — todo el juego: arena, física, IA, disparo, partículas, oleadas y audio.

## Ajustes rápidos

Las constantes del principio de `main.js` controlan el balance: `WEAPON` (daño, cadencia,
cargador), `ENEMY_TYPES` (vida, velocidad, puntos), y `ARENA` / `WALK` / `SPRINT` /
`GRAVITY` para el movimiento. La intensidad del brillo está en el `UnrealBloomPass`.
