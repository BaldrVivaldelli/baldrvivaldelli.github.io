# El fondo que nadie mira

*Quise usar un video de YouTube como fondo de escritorio, y usar la excusa para entender de verdad qué hace FFmpeg. Terminó en un programa en C que decodifica en la GPU, no pasa un solo píxel por la CPU y se apaga cuando nadie puede verlo. Primera parte de dos: esta es la de llegar. La que sigue es la de inventar los cuadros que faltan.*

telon es un fondo animado para Hyprland escrito en C sobre FFmpeg y wlr-layer-shell. El nombre viene de telón de fondo, que es exactamente lo que es: la capa que está detrás de todo lo demás.

Nació de un capricho. Hay un video en YouTube de seis horas en el que Appa, el bisonte volador de Avatar, pasa una y otra vez delante de la luna. Lo quería de fondo. Y quería que el camino para tenerlo fuera un laboratorio: FFmpeg propone un puñado de conceptos (contenedores, paquetes, cuadros, bases de tiempo, formatos de píxel, grafos de filtros) que uno usa desde la línea de comandos sin entenderlos del todo. Un fondo de escritorio es el programa más chico posible que los necesita a todos.

Como en mure, Claude escribió buena parte del código. Las preguntas, el orden, qué medir y qué no aceptar fueron míos.

La pregunta que terminó ordenando el proyecto fue:

**¿Cuánto cuesta un fondo que se mueve?**

La respuesta, después de tres versiones:

**el dos por ciento de un núcleo, siempre que no toques los píxeles.**

## Un video es tiempo, no cuadros

Lo primero que FFmpeg te obliga a aceptar es que un archivo de video no es una lista de imágenes.

Es una caja, el contenedor, con varios flujos adentro. Cada flujo viene en paquetes. El códec convierte paquetes en cuadros, y no lo hace uno a uno: los cuadros B se codifican mirando hacia adelante, así que salen desordenados y con retraso. Al final del archivo hay que drenar el decodificador para que suelte lo que se guardó.

Y los cuadros no tienen fps. Tienen un instante.

Cada paquete trae un PTS, un entero en unidades de una base de tiempo racional, que en un mp4 suele ser algo tan arbitrario como 1/15360 de segundo. telon lo convierte a reloj de pared recién al final, con aritmética racional hasta ahí:

$$
t_{\mathit{due}} = t_0 + (\mathit{pts} - \mathit{pts}_0) \cdot \mathit{tb}
$$

donde $$t_0$$ es el instante en que el video empezó. Un fondo tiene que dar vueltas, y la vuelta también es tiempo: al llegar al final, telon mide cuánto duró, le suma eso a $$t_0$$, vuelve al principio con un seek y vacía el decodificador. El reloj nunca salta. Si el compositor deja de pedir cuadros un rato largo, se corre $$t_0$$ en vez de tirar cuadros a lo loco para alcanzarlo.

Suena a detalle. Es la diferencia entre un fondo que fluye y uno que trastabilla cada cuarenta segundos.

## El compositor manda

La segunda cosa que hay que aceptar es que un programa de escritorio no dibuja cuando quiere.

En Wayland, el fondo es una superficie en la capa *background* de wlr-layer-shell, una por monitor, anclada a los cuatro bordes. El compositor avisa con un *frame callback* cuando terminó de dibujar el cuadro anterior; recién ahí conviene entregar el siguiente. Nunca más rápido que el refresco, nunca con tearing, nunca un cuadro que nadie va a ver.

El recorte y la escala tampoco los hace uno. Con viewporter se le dice al compositor qué rectángulo del video mostrar y en qué rectángulo de la pantalla, y él lo resuelve en su propio render, que ya está corriendo de todos modos.

La v1 hacía todo lo demás por software: decodificar en la CPU, convertir de YUV a RGB con swscale, escribir en un buffer de memoria compartida. A 2560x1440 y 30 cuadros por segundo costaba el 19 % de un núcleo.

Lo interesante fue por qué 19 y no 35, que fue el primer número.

`ffmpeg` decodifica el mismo clip en el 14 % de un núcleo si lo dejás correr a toda velocidad, y en el 28 % si lo limitás a tiempo real. Es el mismo trabajo. La diferencia es el gobernador de frecuencia: una carga a cuentagotas, un cuadro cada 33 milisegundos, no convence a la CPU de subir el reloj, así que cada cuadro se decodifica a frecuencia baja y tarda más. telon llena su cola en ráfagas, decodifica hasta llenarla y después duerme largo, y el costo bajó casi a la mitad. Por la misma razón el default es un solo hilo de decodificación: con cuatro, los hilos se mantienen despiertos entre cuadros y la cuenta sube al 39 %.

**Una carga a cuentagotas es la peor carga posible para un gobernador.** Lo anoto porque me lo voy a volver a cruzar.

## ¿Y a 120?

Mi monitor externo hace 60 Hz. La pantalla de la notebook, 2880x1800 a 120. La pregunta era inevitable: ¿se puede?

Se puede decodificar: por software, un clip de 2880x1800 a 120 cuadros por segundo sostiene los 120. Cuesta el 129 % de un núcleo.

El número me molestó, y preguntar por qué cambió el proyecto.

Un cuadro de 2880x1800 son 5,2 millones de píxeles. En YUV 4:2:0, el formato en que sale del decodificador, son 1,5 bytes por píxel: 7,8 MB que el decodificador escribe. La conversión los lee y escribe 20,7 MB de RGB, a 4 bytes por píxel, en el buffer compartido. Y el compositor tiene que subir esos 20,7 MB a la GPU. Ciento veinte veces por segundo:

$$
120 \cdot (7{,}8 + 7{,}8 + 20{,}7 + 20{,}7)\ \mathrm{MB} \approx 6{,}8\ \mathrm{GB/s}
$$

de tráfico de memoria para mostrar un fondo. Lo caro no era decodificar. **Era tocar los píxeles.**

La decisión salió sola: siempre por GPU. El camino por software quedó detrás de una opción, por si algún día no hay decodificador de hardware.

## Nunca tocar los píxeles

Esta máquina tiene dos GPUs: una Radeon 780M integrada y una RTX 4060. Lo primero fue averiguar con cuál dibuja Hyprland, porque la única forma de no copiar es que el decodificador y el compositor compartan memoria. Es la AMD. Y la AMD tiene un decodificador de video, el VCN, al que se llega por VA-API: decodifica el clip de 2880x1800 a 590 cuadros por segundo si lo dejás, y a tiempo real le cuesta a `ffmpeg` el 14 % de un núcleo.

Con eso, el camino de la v2 es una cadena en la que ningún eslabón pasa por la CPU:

1. libavformat lee paquetes del archivo.
2. libavcodec se los entrega al VCN a través de VA-API; el cuadro decodificado queda en una superficie de memoria de video.
3. Un grafo de libavfilter con un solo filtro, el escalador de VA-API, convierte esa superficie a RGB. En la GPU. Por qué a RGB y no el YUV directo, más abajo.
4. `vaExportSurfaceHandle` exporta la superficie como DMA-BUF: un descriptor de archivo del kernel que apunta a esa memoria, con el formato, los planos y el *modificador*, que describe cómo está tileada.
5. El compositor la importa por linux-dmabuf y la dibuja como una textura más, sin saber que es un video.

Hay dos detalles que me costaron horas y que son, creo, donde está el aprendizaje.

El primero: el grafo de filtros no se puede armar hasta que no existe el primer cuadro, porque recién ahí se sabe en qué pool de superficies vive. Y ese pool es fijo: el decodificador reserva las superficies de referencia que necesita el códec y nada más. Si el programa retiene cuadros, y telon retiene varios en su cola mientras el compositor retiene el que está mostrando hasta soltarlo con un *release*, hay que pedirle al decodificador superficies de más, de antemano. Si no, se queda sin lugar y la decodificación se traba en silencio.

El segundo: cada superficie exportada se convierte en un `wl_buffer`, y crear uno no es gratis. telon los cachea por identidad de superficie, así que después de la primera vuelta del pool no se crea nada más. El cuadro se retiene hasta que el compositor lo suelta, y recién entonces vuelve al decodificador.

Los números, en un Ryzen 9 8945HS con Hyprland 0.56 dibujando en la 780M, CPU como fracción de un núcleo:

| Clip | Camino | telon | Hyprland | GPU | Presentados |
|---|---|---|---|---|---|
| 2560x1440 a 30 | GPU | 2 % | 5 % | 9 % | 30, ninguno tirado |
| 2880x1800 a 120 | GPU | 6 % | 7 % | 22 % | 60, el tope del monitor |
| 2560x1440 a 30 | software, 1 hilo | 19 % | 4 % | 4 % | 30 |
| 2880x1800 a 120 | software, 1 hilo | 129 % | | | sostiene 120 decodificados |

Del 129 % al 6 %. El mismo video, los mismos cuadros, la misma pantalla. La diferencia es que nadie los toca.

## Lo que Hyprland no dice

Acá va la parte que más se parece a lo que aprendí con mure: una contraparte real tiene derecho a contradecirte, y el compositor es una contraparte real.

Cuatro cosas que no están en ninguna documentación y que salieron de medir:

- **NV12 por DMA-BUF se ve rojo.** Hyprland anuncia el formato, importa el buffer y muestrea solo el plano de luma. Todo en tonos de rojo. Por eso la conversión a RGB en la GPU: no es una elección estética, es que el YUV directo no funciona hoy. Queda una opción para compositores que lo hagan bien.
- **Una subsuperficie recibe su frame callback un refresco tarde.** Si el video va en una subsuperficie sobre un fondo negro, la cadencia queda clavada en la mitad del refresco: 30 en un monitor de 60. El video va directo en la capa; la subsuperficie quedó solo para el modo con bandas negras.
- **Declarar daño con `INT32_MAX` rompe el render.** Es el idioma habitual para decir "cambió todo". Con un viewport que escala, el compositor multiplica ese rectángulo por la escala, desborda, y el daño queda vacío. Sin daño no hay re-render ni callback: el fondo se congela sin ningún error. Se declara el tamaño real y listo.
- **Sigue pidiendo cuadros a una capa tapada.** Con una ventana a pantalla completa adelante, Hyprland le sigue mandando frame callbacks al fondo. Lo verifiqué con una terminal en fullscreen: 30 cuadros por segundo parejos, decodificados y pintados, sin que nadie pudiera verlos.

Ninguna es un bug grave. Todas son el tipo de cosa que un programa que "funciona" a la primera no descubre nunca.

## El fondo que nadie mira

La cuarta llevó a la v3.

Si el compositor no avisa que el fondo está tapado, hay que preguntarle a quien sí lo sabe. Hyprland tiene un socket de eventos: una línea por cosa que pasa, `fullscreen>>1`, `workspace>>3`, `openwindow>>...`. telon lo escucha, y ante los eventos que importan le pregunta por el otro socket qué monitores hay y qué ventanas tiene cada uno, con un lector de JSON de cien líneas escrito para la ocasión, porque para leer dos claves del primer nivel no hacía falta una biblioteca.

Con eso sabe, por monitor, si hay una ventana a pantalla completa en el workspace visible. Si la hay, pausa. Y pausar es gratis por construcción: el presentador deja de sacar de la cola, la cola se llena, y el decodificador, que bloquea cuando no tiene dónde poner, se duerme. Cero CPU, cero GPU, sin ningún código especial de pausa. Al volver, se corre $$t_0$$ y el video sigue como si nada.

**Lo que nadie ve no debería costar nada.** Es la regla más simple del proyecto y la que más costó cumplir, porque el sistema no te ayuda a saber cuándo nadie ve.

## El video que no existe

Faltaba el video.

El original tiene seis horas y está en YouTube, donde bajar algo ya es un trámite: sin las cookies de una sesión, yt-dlp recibe un desafío de bot y, si insistís, un 429. Las exporté con una extensión del navegador y bajé solo un tramo de un minuto, en la mejor calidad que ofrece, que es 1080p.

Pero un fondo de seis horas es una tontería. El video es un loop de unos cuarenta segundos pegado cientos de veces, y lo que quería era ese loop, exacto, para que la vuelta no se note.

Encontrarlo es un problema de señal. Para cada cuadro $$t$$ del tramo, una miniatura de 64x36 en gris, y su distancia al primer cuadro:

$$
d(t) = \frac{1}{N} \sum_{p} \left| I_t(p) - I_0(p) \right|
$$

Durante el primer segundo, $$d$$ mide el ruido de la compresión. Después crece, mientras Appa se aleja, y vuelve a caer cuando el video vuelve a empezar. El período es el primer mínimo local que queda por debajo de un cuarto de ese ruido inicial. Dio 40,333 segundos: 1210 cuadros a 30 por segundo, exactos.

El corte se hace por cantidad de cuadros, no por segundos, porque 40,333 no es representable y un cuadro de más o de menos es un salto visible. Y si un video no tiene período limpio, queda el plan B: un tramo con un fundido cruzado entre el final y el principio.

La costura del loop quedó en 0,34 de distancia entre el último cuadro y el primero, contra 0,15 entre dos cuadros consecutivos cualesquiera. Dos veces un paso normal. A 30 cuadros por segundo no se ve.

Todo eso quedó en un comando: la URL, el minuto y la opción de arrancar el fondo. Un minuto después, Appa vuela.

## Mientras tanto, logind

Una yapa dentro de la yapa, porque salió de la misma tarde y de la misma pregunta: ¿qué hace la máquina cuando nadie la mira?

Pedí un script para que la notebook no se suspendiera nunca. Antes de escribirlo miré el journal y encontré que `systemd-logind` llevaba dos días y medio de CPU acumulada en cinco días de uptime. Cada vez que me alejaba, pedía suspender la máquina entre 170 y 270 veces por segundo, durante horas, y PID 1 se lo rechazaba cada vez porque el target estaba enmascarado.

La cadena: la tapa de la notebook está cerrada, uso el monitor externo. A los cinco minutos sin actividad Omarchy bloquea y apaga el monitor. logind cuenta los monitores externos leyendo sysfs, y con el monitor apagado deja de contarlo. Tapa cerrada sin monitor externo quiere decir "suspender". El pedido falla. Y el chequeo de la tapa corre después de cada vuelta del loop de eventos, así que vuelve a pedir. Para en el instante exacto en que toco una tecla y el monitor prende.

El script quedó, con nombre y todo: vigilia. Corta la cadena en logind y, por las dudas, en todas las otras capas. Pero la lección es la del fondo: **lo que pasa cuando nadie mira es lo que nadie mide.**

## Lo que me llevo

Seis reglas, como siempre.

**Un video es tiempo, no cuadros.**  
PTS y base de tiempo, en racionales hasta el último momento. El fps es una consecuencia, no un dato.

**Lo caro es tocar los píxeles, no decodificarlos.**  
Del 129 % al 6 % sin cambiar el video. Si un byte no pasa por la CPU, no se paga.

**El compositor manda, y es una contraparte real.**  
Dibuja cuando él dice, escala lo que él escala, y tiene cuatro comportamientos que ningún documento cuenta.

**Una carga a cuentagotas engaña al gobernador.**  
Medí contra `ffmpeg -re`, no contra una corrida a fondo. Llená en ráfagas y dormí largo.

**Lo que nadie ve no debería costar nada.**  
Y como el sistema no avisa cuándo nadie ve, hay que preguntar.

**El loop perfecto es una señal.**  
Una distancia, un mínimo, un umbral. Mil doscientos diez cuadros.

## Lo que sigue

El video es de 30 cuadros por segundo. La pantalla de la notebook hace 120. Hoy cada cuadro se muestra cuatro veces seguidas, y en un paneo lento, que es lo único que hace Appa, se nota.

La segunda parte es inventar los tres cuadros que faltan entre cada dos. Eso ya no es FFmpeg entendiendo un archivo: es estimar el movimiento, flujo óptico, y decidir qué hacer con lo que un cuadro tapa y el siguiente destapa. Hay un filtro clásico que lo hace comparando bloques y hay redes que aprendieron a hacerlo. Antes de elegir, quiero un experimento que no dependa de mi ojo: esconder la mitad de los cuadros de un video que tengo entero, pedirle a cada método que los invente, y medir cuánto se parecen a los verdaderos.

Pero esa es otra nota.
