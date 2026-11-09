# El tiempo que no se suma

*Construí un motor de inferencia por pasadas para una sola notebook, para superar una barrera que llama.cpp parecía tener con los expertos en la CPU. La barrera no era del programa: era el reloj de la placa de video en ralentí y la carga de mi propio escritorio. El motor quedó igual de rápido que lo que quería superar, pero correcto bit a bit y con una propiedad medida como identidad: con dos pasadas en vuelo, el tiempo de la GPU deja de sumarse. Y lo que me llevo no es un número: es la diferencia entre reordenar el trabajo y hacer menos trabajo.*

La nota anterior terminó con una palanca: tokens por pasada. En una sola PC, una pasada que lleva muchos tokens lee el modelo una vez y reparte ese costo entre todos. Quise construir el motor que hace eso en la máquina que tengo: una notebook con un Ryzen de ocho núcleos, 30 GB de RAM y una RTX 4060 de 8 GB, con el escritorio andando, porque es la máquina en la que vivo.

El modelo de prueba es OLMoE: 16 capas, 64 expertos por capa, 8 activos por token, 6,9 GB en 8 bits; entra entero en la RAM, y en 4 bits entra entero en la placa, que da el techo de "todo en VRAM". El que me interesa es el de la nota anterior, Qwen3.8-Flash-Next, que en esta notebook no entra.

Como en las notas anteriores, Claude escribió casi todo el código y casi todas las demostraciones; otros agentes de Claude leyeron el fuente, corrieron los bancos y refutaron cada informe. La dirección, las preguntas y los rechazos fueron míos. También fue mía una acción fuera del flujo que cambió un experimento sin que los agentes lo supieran; la cuento más abajo.

La pregunta que ordenó todo:

**¿Cuánto puede devolver el paralelismo, y cuánto hay que hacer de menos?**

## Una pasada no puede ser más corta que su recurso más lento

El teorema del motor está en Lean, uno de los cincuenta y seis de la nota anterior. Una pasada de $$B$$ tokens tarda al menos el máximo, sobre los recursos, de trabajo dividido por capacidad:

$$
t(B) \;\ge\; \max\!\left(\frac{\mathit{bytes}(B)}{\mathit{ancho}},\ \frac{B\cdot \mathit{trabajo}}{\mathit{flops}},\ \mathit{profundidad}\right)
$$

Lo sincrónico suma: si la CPU calcula los expertos y después la GPU calcula la atención, la pasada dura la suma. Lo asincrónico convierte la suma en máximo: si las dos trabajan a la vez, sobre pasadas distintas, la pasada dura lo que dura la más lenta. Esa es toda la promesa del paralelismo, y el teorema dice también su tamaño: nunca más que la suma menos el máximo.

Convertí el teorema en una calculadora con las constantes de la notebook, y la calculadora en cinco predicciones antes de correr nada: con un token la CPU gana (34 tokens por segundo contra 15 por PCIe); la CPU se clava en unos 150 por su propio cómputo; el PCIe conviene recién con lotes de más de cien tokens; un experto residente en la placa vale más cuanto más grande es el lote; y el techo con todo en la placa es el cómputo de la GPU, unos 5.800.

## La noche de la primera medición

Medí llama.cpp (por Vulkan: acá no hay CUDA) en cada configuración. Las cinco predicciones se cumplieron en el signo y ninguna en el número. La CPU no se clavó en 154 sino en unos 200. El techo quedó al 43 %: 2.510 tokens por segundo. Y la primera corrida mintió dos veces; desde entonces ninguna celda vale con una sola corrida.

**¿El teorema estaba mal?**

No. Estaban mal los números con que lo alimenté. Cada constante de la caja era el rendimiento de una herramienta, no una propiedad de la máquina:

| Constante | Lo que puse | Lo que salió al medir | Qué era |
|---|---|---|---|
| Ancho de RAM | 33 GB/s | 45 o más | el límite del programita que medía |
| Cómputo de la CPU | 500 GFLOPS | 553 de promedio; 410 a 430 en el kernel de expertos, 560 a 720 en los densos | una corrida que medía PCIe |
| Profundidad | 2 ms | 5,3 ms para un token todo en GPU: 389 despachos | una función, no una constante |
| GPU | 15 TFLOPS | 10,5 a 11,5 bajo el tope de 55 W; 7,4 efectivos con 128 tokens | el pico nominal |

La "profundidad" fue la que más me enseñó. Un ajuste lineal de tiempo contra tokens da una ordenada al origen, y no es un costo fijo. Es la suma de cosas con dependencias distintas: una cadena de cientos de despachos cuya latencia depende del reloj de la GPU; bytes que crecen con el lote pero saturan, porque una pasada de 32 tokens ya toca la mayoría de los expertos, y que la recta proyecta como constante; escalones de política del programa. No es un número de la caja. Es una función.

Uno de esos escalones explica el pozo más feo de la curva. Con los expertos en la CPU, llama.cpp daba 109 tokens por segundo en $$B = 32$$, y 75 con su política por defecto. Adentro hay una regla fija: si los pesos viven en la RAM y el micro-lote tiene 32 tokens o más, la operación va a la GPU y los pesos se suben en cada pasada. Son unos seis gigabytes por pasada por el PCIe: 425 a 560 milisegundos, casi planos de 32 a 128 tokens. Y 32 cae justo donde la CPU todavía gana. Si se mueve el umbral a 8, el pozo se muda a $$B = 8$$. No es física. Es un número escrito en el código.

Después de restar la RAM, el cómputo y la parte densa de la GPU, con los expertos en la CPU sobraban unos 3 milisegundos por token desde $$B = 4$$: la mitad de la pasada con 128 tokens. Le pusimos nombre, penalidad de alternancia, y quedó como término medido sin mecanismo. Es el protagonista de la nota, porque no existe.

## La hipótesis del arranque en frío

Hay que mirar cómo ejecuta ggml, la biblioteca de kernels debajo de llama.cpp. Una pasada es un grafo de flujo de datos: nodos que son operaciones, aristas que son tensores. Lo ejecuta un intérprete, en orden, y en la CPU cada nodo termina en una barrera donde los ocho hilos se esperan. Si el grafo tiene partes en dos dispositivos, el planificador lo corta en tramos y sincroniza en cada corte: mientras la CPU calcula, la GPU espera, y al revés. Con los expertos en la CPU son 34 cortes por pasada. Nadie es dueño de nada: los hilos sin trabajo al rato se duermen, y la GPU entre tramos cae al ralentí, 210 MHz.

La hipótesis fue esa: la penalidad es arranque en frío, de los dos lados, decenas de veces por pasada.

La respuesta de diseño fue un reparto fijo de actores. Un hilo dueño de la GPU. Un equipo de siete hilos fijados a siete núcleos, dueño de los expertos, que nunca duerme. Entre ellos, anillos sin candados con mensajes de cuatro bytes: qué ranura, qué capa, qué pasada. Y dos pasadas en vuelo: la GPU hace la atención de la capa $$k$$ de una pasada mientras la CPU hace los expertos de la capa $$k$$ de la anterior. El modelo predecía, si la penalidad era arranque en frío, ×1,5 a ×2,1 sobre llama.cpp.

## Calor: lo que se escribió antes de medir

Antes de tocar el motor quise probar la hipótesis sobre llama.cpp mismo: hilos en espera activa, anclados a núcleos, un núcleo libre para el controlador de la GPU, y los expertos en memoria común en vez de la fijada del controlador. Las predicciones quedaron escritas a las 11:10, con las reglas de decisión: "mejora" es una mediana que baja más del 10 % y queda fuera del rango; si la corrida por defecto de hoy queda a ±10 % de la de anoche en $$B = 16$$ y 128, el lado GPU queda refutado.

Y acá está la acción mía. Alrededor de las once, a pedido del asistente, fijé los relojes de la GPU con `pkexec nvidia-smi -lgc 1500,2500`, desde mi terminal, fuera del flujo. Los agentes tenían prohibido usar `sudo` y `pkexec`, y nadie les contó. La primera sonda, minutos después, encontró la GPU a 1500 MHz en reposo, donde anoche marcaba 210, y el experimento cambió solo: ya no había control con la GPU libre el mismo día. El informe lo declaró y siguió.

Noventa y dos corridas después:

- **El lado CPU, refutado.** Espera activa, anclaje o un núcleo libre dan lo mismo que el control a igual carga, ±3 % intercalado. Los núcleos ya corrían a 4,0 a 4,3 GHz efectivos. No había nadie dormido que despertar.
- **La memoria fijada, refutada.** Da el mismo tiempo que la común, con o sin páginas grandes.
- **El lado GPU, parcial.** Con la GPU despierta, el mismo comando de anoche bajó de 785 a 515 milisegundos en $$B = 128$$ con la máquina quieta. Pero es una comparación entre días, y la regla previa daba "refutado" en $$B = 16$$, donde no mejoró. Se reinterpretó después con datos de la tarde. Fue post hoc y hay que decirlo.
- **Un factor que no estaba en ninguna hipótesis.** La carga de mi escritorio: entre 0,4 y 2,4 núcleos de un navegador, el compositor y el fondo animado sobre la gráfica integrada, que comparte la memoria con la CPU. Cuesta entre 45 y 57 % en lotes chicos y entre 8 y 16 % en los grandes. Explicó más dispersión que todas las condiciones juntas.

## El motor propio, bit a bit

El motor se construyó sobre ggml como biblioteca de kernels, sin el grafo de llama.cpp. La primera prueba de aceptación: los mismos logits que llama.cpp todo en CPU, exactamente. Cero de diferencia en 256 posiciones por 50.304 logits, en seis combinaciones de caché y de tokens. Pasó las seis.

**¿Por qué exigir bit a bit y no una tolerancia?**

Porque comparar tiempos es honesto sólo si los dos programas hacen el mismo trabajo, y porque una optimización que cambia los números no es una optimización: es otro modelo. Y porque la exactitud obliga a descubrir. Con la caché en 32 bits, llama.cpp la convierte a 16 antes de la atención, así que "más precisión" no era más precisión. Con la caché cuantizada aplica una rotación de Hadamard que no es parte del modelo y cambia la decisión en 10 a 34 tokens de 256. Y un criterio del diseño estaba mal calibrado: pedía que el router coincidiera en el 99 % con la referencia en CPU, y llama.cpp en Vulkan coincide consigo mismo en CPU sólo en el 84 a 93 %: las tolerancias por operación no componen sobre 16 capas con un router de 64 expertos. El criterio pasó a ser bit a bit contra llama.cpp con el mismo reparto, y también pasó.

Con dos pasadas en vuelo los logits son bit a bit iguales a los de una, y mil pasadas seguidas no se trabaron. El prototipo es correcto. Falta ver si es rápido.

## Dos pasadas en vuelo

La medición formal fue a la tarde, con la máquina quieta y llama.cpp intercalado en la misma tanda. Tokens por segundo, con los milisegundos por pasada entre paréntesis:

| $$B$$ | llama.cpp anoche, GPU en ralentí | llama.cpp hoy, GPU despierta | Secuencial: una pasada por vez | Dos pasadas en vuelo |
|---|---|---|---|---|
| 1 | 41 (24,2) | 40 (24,8) | 41 (24,2) | **51 (19,7)** |
| 4 | 61 (65,8) | 76 (52,9) | 74 (53,7) | 68 (59,2) |
| 8 | 61 (130) | 106 (75,8) | 103 (77,5) | 99 (80,5) |
| 16 | 99 (161) | 150 (107) | 144 (111) | 146 (109) |
| 32 | 109 (293) | 194 (165) | 181 (177) | 188 (170) |
| 64 | 131 (489) | 228 (281) | 203 (314) | 211 (304) |
| 128 | 163 (785) | 250 (512) | 215 (595) | 220 (580) |

La segunda columna es la refutación de la barrera: el mismo comando de llama.cpp, sin cambiar una línea, pasó de 109 a 194 tokens por segundo en $$B = 32$$ con la GPU despierta y el escritorio quieto. La barrera que quería superar con un motor nuevo la superó el estado de la máquina. La penalidad de alternancia es cero, en llama.cpp y en el motor.

La última columna es la tubería. Con dos en vuelo la GPU queda escondida del todo: el período es el paso de expertos más entre 0,1 y 1,1 milisegundos. Pero el máximo posible es chico: la GPU es el 3 a 6 % de la pasada desde $$B = 32$$, y se cobra el 67 a 80 % de eso, un 2 a 5 % neto. En $$B = 1$$, donde la GPU y los cruces son cinco milisegundos de veinticuatro, la tubería gana el 23 %. Es la única celda donde gana de verdad, con una sola corrida: hay que replicarla.

El diseño predecía 47 / 105 / 140 / 241 / 455 milisegundos para dos en vuelo en $$B = 4$$ a 128; salieron 59 / 109 / 170 / 304 / 580. La forma, no la magnitud: supuse 484 GFLOPS para los siete núcleos y el paso de expertos rinde 306 a 361. El ×1,5 a ×2,1 no apareció porque la referencia se movió.

Con siete hilos el prototipo pierde contra llama.cpp entre 4 y 14 % desde $$B = 32$$: el diseño reserva un núcleo para el actor de la GPU, y desde ahí la pasada es cómputo de expertos. Con ocho hilos empata: 161,6 contra 162,8 milisegundos en $$B = 32$$, 523 contra 512 en 128.

En los lotes chicos pierde contra sí mismo: con dos en vuelo, en $$B = 4$$ y 8, un obrero de los siete se detiene unos 14 milisegundos en capas sueltas y la barrera multiplica la detención por siete. Nunca con una pasada por vez. Cuesta 26 % del paso de expertos en $$B = 4$$, 16 % en 8, 5 % en 16, nada desde 32; el mecanismo está abierto.

El lema de la tubería, medido:

| $$B$$ | Expertos solos, CPU | GPU sola | Dos en vuelo, período | Alargamiento de los expertos bajo solape |
|---|---|---|---|---|
| 4 | 46,8 ms | 6,9 ms | 59,2 ms | 26 % |
| 16 | 100,9 | 10,2 | 109,2 | 8 % |
| 32 | 166,0 | 10,9 | 169,8 | 2 % |
| 64 | 301,0 | 13,2 | 303,9 | 0,8 % |
| 128 | 575,9 | 19,3 | 580,5 | 0,6 % |

Con una pasada por vez la suma cierra al 0,1 %. Con dos, la conclusión del lema se cumple como identidad: período igual al paso más lento más el costo de pasar de mano. Lo que falla en lotes chicos es su hipótesis, que una etapa no se alargue porque la otra trabaje a la vez. Se alarga. El teorema vale con el tiempo medido en situ, no con el medido aislado.

## Lo que aceptamos y lo que no

Dos agentes refutaron el cierre, uno desde la estadística y otro desde el mecanismo. Veintitrés objeciones aceptadas o parciales, cuatro rechazadas.

Las que más dolieron. La regresión de Calor contra la carga ajena no era una recta: en $$B = 32$$ el ajuste descansaba en un solo punto y en 128 los datos eran dos cúmulos. La carga del escritorio es un escalón, no una covariable, y el coeficiente de 140 a 170 milisegundos por núcleo ajeno no existe: varía ×3 entre sesiones del mismo día y depende de qué corre, no de cuántos núcleos ocupa. El "porcentaje del piso" cayó como métrica: varios programas "superaban el 100 %" porque el piso contaba cómputo que la configuración no hace. Y "con texto real la pasada es más rápida" era una corrida sola dentro del ruido.

La que no aceptamos. Un refutador leyó el estado de la GPU en vivo, encontró el piso de 1500 MHz sin rastro del comando en guiones ni bitácoras, y concluyó que los relojes los fijó "una política de causa desconocida". No. Los fijé yo, a las once, desde mi terminal; el rastro no estaba en el repositorio porque el comando no pasó por él. Lo que queda en pie es peor que un misterio: la comparación entre GPU despierta y en ralentí es entre días, el motor no produce ese estado por sí mismo, y "dos en vuelo mantiene la GPU despierta" nunca se probó contra una GPU libre de dormirse. El experimento que lo cierra: soltar y volver a fijar los relojes el mismo día, e intercalar.

## Dónde está el tiempo

**Si no está en la alternancia, ¿dónde está?**

En el kernel. Desde $$B = 32$$ el paso de expertos es el 94 a 97 % de la pasada (91 % en $$B = 16$$) y rinde entre 51 y 54 GFLOPS por hilo, igual en los tres programas. El kernel de ggml para pesos de 8 bits hace, por cada par fila y token, un producto punto sobre 64 bloques de 32 enteros, con instrucciones de 256 bits, dos conversiones de medio flotante por bloque y un solo acumulador, así que cada bloque espera al anterior. Saca 8 de las 64 multiplicaciones enteras por ciclo que puede hacer cada núcleo: el 9,5 % del pico. Con los expertos en 8 bits y ese kernel, el techo en esta notebook es unos 250 tokens por segundo para cualquier programa, y llama.cpp ya está ahí.

**¿Y con otro kernel?**

Una semana después lo medí. Escribí un kernel propio por baldosas, de 32 filas por 6 tokens, con instrucciones enteras de 512 bits. Lo corrí sobre los pesos reales de una capa reempacados, con los ocho núcleos leyendo desde la RAM y el escritorio andando. En el mismo arnés que el kernel de ggml, y con los mismos resultados salvo redondeo (3·10⁻⁷), el paso de expertos de una pasada de 128 tokens bajó de 518 a 162 milisegundos: 3,2 veces. Ahí el paso queda atado al bus, leyendo al 86 % de lo que la RAM daba en ese momento. El techo de 250 era del kernel, no de la máquina.

Pero en el modelo que de verdad me interesa, con 512 expertos por capa y 10 activos, una pasada de 128 tokens toca 465 expertos con menos de tres tokens cada uno. Medidos con pesos sintéticos de esa misma forma, los dos kernels empatan: no hay pesos que reusar entre tokens y todo es bus. Para ese modelo, el kernel recién importa con cientos de tokens por pasada.

Y en los bytes, que no eran los que creía: el teorema cuenta expertos distintos por pasada, yo usaba la cota del ruteo uniforme, y medí las elecciones del router. Con los tokens al azar del banco, en $$B = 128$$ se leen 50 de 64 expertos por capa: el banco subestima los bytes un 25 %. Con texto real se leen 62: la hipótesis de popularidad que había escrito a ciegas era correcta para texto y no para el banco. Para elegir qué expertos residen en la placa hay que usar la popularidad del texto.

## Reordenar no es reducir

Todo lo que construí reordena el mismo trabajo: la misma cantidad de bytes y de multiplicaciones en otro orden, y el teorema dice el premio exacto. La suma se vuelve máximo, y el máximo era el 94 a 97 % de la suma. Ya está construido, medido y acotado: 2 a 5 % en lotes grandes y quietos, 23 % en un token. No hay nada más que recuperar por ese lado.

Lo perezoso es otra cosa: hace menos trabajo. Los lenguajes de programación la nombran: llamada por valor contra llamada por necesidad. Por valor, cada argumento se calcula entero antes de usarse. Por necesidad, se calcula lo que el resultado necesita, cuando lo necesita.

Hoy los expertos se activan por valor. El router elige ocho, la capa espera a que los ocho terminen enteros, los pondera, los suma, y el router de la capa siguiente espera la suma. Nada se usa antes de estar completo, y todo se completa. Pero lo que la pasada necesita al final es un token: el argmax de una fila de logits. Y un argmax no necesita todos los dígitos de todos los sumandos. Necesita saber que ningún sumando pendiente puede cambiar el orden.

## Cuatro formas de pereza

Cada una con su condición de exactitud, porque sin eso es otro modelo.

1. **Suma parcial con parada por margen.** Calcular los expertos en orden de peso del router y detenerse cuando la cota de lo que falta no alcanza para cambiar la decisión. Exacta, con una cota de cola demostrable en Lean.
2. **Pereza por fila dentro del experto.** Calcular sólo las filas que la activación necesita después de la compuerta: el soporte de la nota anterior. Aproximada.
3. **Borrador perezoso con verificación diferida por lotes.** Generar con pocos expertos y verificar en lote con el cómputo completo. Exacta en distribución: decodificación especulativa con el mismo modelo recortado como borrador.
4. **Activación optimista.** Empezar la capa siguiente con una predicción del router y corregir al llegar. Esconde latencia; no hace menos trabajo, pero el que hace de más es paralelo.

El experimento que decide: cortar en 1, 2 y 4 expertos de los 8 y medir el acuerdo del argmax con el cómputo completo, por capa y por margen. Si con cuatro expertos el token coincide casi siempre, la mitad de los bytes sobran casi siempre, y el piso baja porque baja su argumento.

## Lo que dio la pereza

La ronda corrió esa misma noche, sobre texto real, con el escritorio en uso y con los criterios escritos antes de medir. Las cuatro condiciones de exactitud quedaron en Lean, 41 teoremas más. Que se cumplan no dice que convengan.

**Con exactitud, casi nada.** La parada por margen no certificó ningún token: la cota de lo que faltaba nunca fue más chica que la distancia entre el primer token y el segundo. Con la cola verdadera, que no se puede conocer de antemano, habría ahorrado el 0,06 % de los bytes. La decodificación especulativa con el modelo recortado como borrador fue exacta: 128 salidas idénticas a la greedy en 128 corridas. Pero leyó más bytes de expertos por token que la greedy, entre 1,16 y 3,18 veces, y su mejor combinación rinde 0,84 de la base, según un modelo que acertó el bucle medido con 2 a 5 % de error.

**Sin exactitud, los bytes bajan y la calidad no aguanta.** Con 6 expertos de 8 la pasada es 1,24 veces más rápida, y con 4, 1,66 veces, en línea recta con los bytes. Pero con 6 el token elegido cambia en el 17 % de las posiciones de texto real, y con 4 en el 31 %.

**Lo que sí promete es anticipar.** El router de la capa siguiente, aplicado a la salida de la capa actual, acierta 7 de los 8 expertos que se van a pedir, y los 2 más pesados el 99,4 % de las veces. No ahorra bytes, pero permite traerlos antes: es una precarga, no un recorte. Falta construirla y medirla.

El porqué está en tres números de OLMoE:

- **El router es plano.** El primer experto se lleva el 23,5 % del peso de los ocho, y hacen falta casi seis para llegar al 80 %.
- **El modelo duda.** La distancia mediana entre los dos primeros tokens es 1,3 logits.
- **Dos tokens seguidos se parecen poco.** Comparten 3 de sus 8 expertos por capa, así que verificar dos lee casi trece expertos, no ocho.

## La tesis

Es una tesis, no un resultado. Para una persona en su casa el régimen es de bytes, no de cómputo: lo que hace rápida o lenta una pasada es cuántos bytes necesita por token. La GPU puede ser modesta: acá, con los expertos en la RAM, es el 3 % de la pasada con 128 tokens. Los multiplicadores son los bytes por token: menos bits por peso, menos bytes en vuelo por residencia de los expertos populares, y la precarga que esconde los que faltan. Menos expertos por token, con exactitud, no salió en OLMoE: su router es plano. Y el escalado por gigabytes de RAM es un atajo: más RAM hace entrar un modelo más grande, pero no cambia los bytes que cada token pide. Mueve el piso de lugar. No lo baja.

## Lo que me llevo

Seis reglas.

**Un teorema sin insumos medidos es aritmética.**  
Cada constante de mi caja era el rendimiento de una herramienta.

**La predicción se escribe antes de medir, con la regla de decisión.**  
Una regla dio "refutado" y se rescató después. Puede ser correcto, pero fue post hoc, y el informe lo dice.

**La máquina en uso es la condición, no el ruido.**  
El escritorio costó hasta 57 % y es un escalón, no una recta que se pueda restar. Se mide en cada corrida.

**Una corrección devuelve a lo sumo lo que su defecto cuesta.**  
Dos pasadas en vuelo esconden la GPU, y la GPU era el 3 a 6 %. El lema dice el tamaño de la ganancia antes de construirla.

**Lo que se compara tiene que hacer el mismo trabajo.**  
Bit a bit contra la referencia, o la comparación de tiempos es entre dos modelos distintos.

**Reordenar no es reducir.**  
Lo asincrónico convierte la suma en máximo, y ahí se termina. Para bajar el piso hay que hacer menos: menos bits, o menos expertos si la calidad lo aguanta. En OLMoE, con exactitud, no lo aguantó.

*Como siempre: casi todo el código y casi todas las demostraciones las escribió Claude, y otros agentes de Claude intentaron refutar cada informe. La dirección, las preguntas, los rechazos y el comando de las once fueron míos.*
