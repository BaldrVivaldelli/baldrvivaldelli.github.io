# El modelo que no entra

*Qwen3.8-Flash-Next pesa 80 GB y lo corro en una PC con 31 GB de RAM y una placa de 10 GB. llama.cpp, en esa máquina, genera unos 10 tokens por segundo. El motor propio de la nota anterior, puesto en esa PC y con este modelo, llegó a 34: tres veces y media más, con la calidad medida contra llama.cpp. Desde esta noche, además, se puede charlar con él desde el navegador, con conversaciones de hasta 16.384 tokens. El salto más grande no vino de una idea nueva: vino de dejar quietos en la placa los expertos que más se usan, y de encontrar una espera que yo creía resuelta y no lo estaba.*

La nota anterior terminó con una tesis: para una persona en su casa el régimen es de bytes, no de cómputo. Lo que hace rápida o lenta una pasada es cuántos bytes necesita por token, y los multiplicadores son menos bits por peso, menos bytes en vuelo por residencia de los expertos populares, y la precarga que esconde los que faltan. Era una tesis sobre OLMoE, un modelo que entraba entero en la RAM. Ésta es la prueba con el modelo que me interesa, en la máquina donde corre.

Como en las notas anteriores, Claude escribió casi todo el código, corrió las mediciones y escribió los informes. La dirección, las preguntas y las decisiones fueron mías: entre ellas, qué probar primero y una idea sobre los temas de una conversación que cuento más abajo.

**¿Se puede correr bien, en una PC de casa, un modelo que no entra ni en la RAM ni en la placa?**

## El modelo que no entra

Qwen3.8-Flash-Next tiene 48 capas. Cada capa tiene 512 expertos, de los que cada token usa 10, más uno compartido que usan todos. La versión que bajé, de unos tres bits por peso, ocupa 79,6 GB: 75 de expertos y menos de 5 de todo lo demás.

La PC es la de cómputo de la casa: un Ryzen 9 5900X de doce núcleos, 31 GB de RAM, una RTX 3080 de 10 GB y un NVMe. La parte densa del modelo, 4,4 GB, entra en la placa. Los expertos no entran en ningún lado: se abren con mmap y Linux guarda en la RAM los que se van usando. Lo que no está, sale del disco.

Por token, el modelo lee 4,4 GB de pesos densos en la placa y unos 0,9 GB de expertos en la CPU. llama.cpp, con los expertos en la CPU y el resto en la placa por Vulkan (acá tampoco hay CUDA), genera entre 9,4 y 10,8 tokens por segundo. Ésa es la vara.

## Bit a bit, primero

El motor arrancó como en la nota anterior: los mismos logits que llama.cpp, exactos, con el mismo reparto entre placa y CPU. Los 300 tokens de prueba, 248.320 logits por token, todos iguales. Así salió a 9,4 tokens por segundo: lo mismo que llama.cpp, porque hacía el mismo trabajo en el mismo orden.

El primer salto fue una tontería con nombre propio. ggml crea y destruye su equipo de hilos en cada grafo de expertos, y acá son entre 50 y 100 grafos por token. Con un equipo fijo, anclado a los núcleos y que nunca se duerme, el motor pasó a 13,5-14,8. Seguía siendo bit a bit igual a llama.cpp.

Después probé la tesis por el lado de la precarga. Un caché propio de expertos en la RAM, leyendo del disco sin pasar por Linux, rindió menos que dejarle la RAM a Linux. Pedirle al núcleo que traiga de antemano los expertos que el router de la capa siguiente probablemente va a pedir, y calcular primero los que ya están, dio lo mismo dentro del ruido. Con el texto repetido entre corridas casi no faltaba nada del disco: no había qué esconder.

## Qué expertos

Antes de mover expertos a la placa quise saber qué son. Le pedí a Claude que definiera categorías y mirara cuáles componen a cada experto, sobre cien documentos: preguntas y respuestas de ocho temas en inglés, un texto narrativo y textos técnicos en castellano.

- **Hay especialización por tema, pero la mitad de lo que parece es azar.** El 32 % de los expertos sale especialista de un tema. Con los temas mezclados al azar sale el 16 %.
- **El idioma es lo más marcado**, y crece con la profundidad.
- **El 42 % no es especialista de nada**: son generalistas.

Los expertos son mezclas. Eso cambió una idea mía. Yo quería que, a medida que una conversación avanza, el motor descartara los expertos de los temas que dejan de usarse: si se habla de computación, para qué tener en la placa los de biología. Con mezclas, descartar por rótulo tira expertos que también sirven para el tema nuevo.

**¿Y si en vez de rotular se olvida?**

Cada experto lleva una cuenta. Cada vez que el router lo elige, suma uno; a cada paso, todas las cuentas se multiplican por 0,98. Los de más cuenta viven en la placa. Un tema que se deja se olvida solo, sin que nadie sepa qué es un tema.

## Los que se quedan en la placa

En cada capa, los expertos de más cuenta se copian a la placa y se calculan ahí; la CPU calcula sólo los que no están. La placa manda los que no tiene a una ranura vacía, toda en ceros, y la CPU pone en cero las columnas de los de la placa, así que la suma de las dos partes es exactamente la salida de los diez.

Ya no es bit a bit: la placa redondea distinto que la CPU. La vara pasa a ser otra, escrita antes: la divergencia KL media contra llama.cpp por debajo de 0,01 y menos del 0,1 % de cambios decisivos, los cambios del token más probable cuando la referencia lo elegía con más de un logit de margen. Fiel.

La primera versión cambiaba 27.000 expertos cada 500 tokens. Eran 52 GB por el bus, y el motor quedó en 15,4. Con el olvido lento y un margen, un experto de afuera entra sólo si su cuenta supera bien la del residente más flojo, y los cambios bajaron a 6.300. Con 24 expertos por capa en la placa, 19,4 tokens por segundo y fiel. llama.cpp con su propio caché de expertos en la placa daba 11,2.

Más tarde medí cada cuánto conviene renovar. Renovar menos, aunque se acierte menos, es más rápido: cada 128 tokens y con un margen del doble, la placa acierta el 55 % y la conversación sube a 24-26.

Y probé mi idea de los temas con una conversación que pasa de ciencia a programación y vuelve. Los aciertos caen en la ventana de cincuenta tokens del cambio y se recuperan en la siguiente. Pero la placa cambia casi lo mismo dentro de un tema que entre temas. No hay un bloque de biología para tirar. Lo que la placa sigue es qué partes del texto se están leyendo, y eso cambia todo el tiempo.

## La espera que no se veía

En el motor, cada capa hace un viaje de ida y vuelta: la placa calcula hasta la entrada de los expertos, la CPU calcula los suyos, y la placa sigue. Son 48 viajes por token, y yo había hecho que cada uno tuviera una sola espera: todas las copias asincrónicas y una única sincronización al final de la capa.

No era así. En Vulkan, una copia "asincrónica" desde memoria común pasa por un búfer intermedio y espera a la placa adentro. Cada una. Seguían siendo cuatro o cinco esperas por capa, unas 200 por token, y el código decía que era una. Lo encontré mirando el código de ggml cuando los números no cerraban. Con esas copias en memoria fijada, que la placa lee directo, la espera sí es una, y la conversación pasó de 24-25 a 29-30 tokens por segundo.

Hubo otra espera escondida, ésta del lado de la placa. Midiendo operación por operación, las multiplicaciones densas iban al 40-50 % del ancho de la memoria de la 3080. Parecía un problema de los kernels. Era el reloj: mientras la CPU calcula, la placa espera, baja sola a 210 MHz y arranca cada capa en frío. Con el reloj fijo, las mismas operaciones tardaban 16,3 milisegundos en vez de 26,2. Con expertos en la placa no hace falta fijarlo: la placa trabaja sin pausa y no se duerme.

El último paso fue de orden. Los expertos de la placa no dependen de la CPU, pero se calculaban recién en el grafo de la capa siguiente, que espera a la CPU. En un grafo propio, lanzado apenas se sabe cuáles van, la placa los calcula mientras la CPU hace los suyos. Son las mismas cuentas, bit a bit iguales, y la conversación llegó a 34.

| | tokens por segundo | contra llama.cpp |
|---|---:|---|
| llama.cpp | 9,4 a 10,8 | |
| el motor, bit a bit | 9,4 | igual |
| con un equipo de hilos fijo | 13,5 a 14,8 | bit a bit |
| con expertos populares en la placa | 19,4 | fiel |
| renovando cada 128 tokens | 24 a 26 | fiel |
| con una espera por capa, de verdad | 29 a 30 | fiel |
| con la placa y la CPU a la vez | **34** | fiel: KL 0,0012, 0 de 175 decisivos |

En el texto que cambia de tema, de 1.928 tokens, la KL media fue 0,0004: veinticinco veces por debajo de la vara.

## Lo que no funcionó

- **Saltear canales de los expertos.** Un experto es la suma de 640 canales, y por token el 90 % de lo que aporta está en unos 166. Pero dejar afuera ese 10 % cambia lo que dice el modelo más de lo que sugería la energía: ninguna regla para elegir canales pasó la vara de fiel.
- **Un mezclador propio.** El modelo mezcla cuatro corrientes en cada capa con unas diez operaciones chicas. Las junté en una operación de la placa con sus propios sombreadores. Fue fiel, pero tardó 64 microsegundos contra 55 de las operaciones sueltas. Quedó apagado.
- **Expertos en la placa con dos conversaciones a la vez.** Dos conversaciones se reparten bien el trabajo, 27 a 30 tokens por segundo entre las dos, pero ahí el límite es la CPU, y lo que se mueve a la placa no se recupera.

## Charlar

Hasta ayer, el motor era un programa de medición: recibía números y devolvía números. Hoy lo hice usable, en cuatro pasos y en ese orden.

**Que hable.** Un frente nuevo atiende la misma interfaz de chat que usan los servicios conocidos, que es la que habla el Open-WebUI de mi casa. Para el texto usa llama.cpp sin placa: el vocabulario, la plantilla de chat del modelo y la separación entre el razonamiento y la respuesta. El cálculo lo hace el motor, que arranca con el primer mensaje y se apaga después de quince minutos sin uso, para devolverle la placa al resto.

El estado de una conversación no se puede volver atrás: la mayoría de las capas son de atención lineal, que resume todo lo leído en un estado que sólo avanza. Para no releer un historial entero en cada turno, el motor guarda copias del estado en la RAM y retoma desde la más larga que sea el principio del pedido. La copia que más sirve es la del final del último mensaje mío, porque el turno siguiente repite todo hasta ahí aunque el Open-WebUI devuelva la respuesta anterior sin el razonamiento.

**Que arranque siempre.** Algunos arranques del motor colgaban al abrir la placa o tiraban errores del controlador. Con el controlador siempre cargado, el modo persistente de NVIDIA, hubo treinta arranques y cierres seguidos sin un error, y el motor queda listo en 2,1 segundos.

**Que sea largo.** Hasta ayer el motor tenía un tope de 2.048 tokens. No era casual: hasta ahí la atención de este modelo es la común. Después usa una atención dispersa: un índice aparte puntúa bloques de cuatro tokens y la atención mira sólo los 512 mejores, más los últimos. La copié de llama.cpp paso por paso, incluida la cadena de operaciones con que arma la máscara en Vulkan. Con 3.181 y con 8.723 tokens, los logits del motor son bit a bit iguales a los de llama.cpp en todas las posiciones. Los 8.723 cruzan el punto donde Vulkan cambia de camino y junta sólo las celdas elegidas.

**Que lea más rápido.** El motor leía el prompt de a un token, igual que genera. Lo cambié para que lo lea en tandas de 16: la placa lee los pesos una vez por tanda.

La primera versión de las tandas dio 51 tokens por segundo, cuatro veces más rápida. Y estaba mal: la KL contra la lectura de a uno era 0,31, y el token más probable cambiaba en el 18 % de las posiciones. Comparando capa por capa apareció en la capa 1: la lista de los diez expertos de cada token sale de la placa como una vista con huecos entre token y token. Con un token no importa. En una tanda, la CPU calculaba para los dieciséis tokens los expertos del primero. Iba rápido porque calculaba de menos.

Arreglada, la tanda es fiel, con KL de 0,0005 y ningún cambio decisivo. Lee el prompt entre 1,4 y 2,3 veces más rápido, según el texto. Menos de lo que esperaba, y la tesis de los bytes dice por qué. Con la placa, la parte de la placa bajó de 47 a 29 segundos, pero la CPU siguió en 50. Dieciséis tokens seguidos casi no repiten expertos: cada uno elige 10 de 512. Para que se repitan hacen falta tandas de miles de tokens. Ahí cada tanda toca todos los expertos, y yo lo descarté porque habría que leer el modelo del disco. Me equivoqué en la cuenta: leer los 45 GB de expertos una vez por tanda, y calcularlos en la placa, cuesta unos segundos repartidos entre miles de tokens. Otros lo hacen así. llama.cpp con lotes de 4.096 tokens lee a unos 400 tokens por segundo en una 3060 con 32 GB de RAM, y un motor hecho para este modelo, a unos mil. Las tandas de 16 eran el régimen equivocado. Es lo próximo.

El contexto largo tiene su precio. La atención dispersa le suma 1,3 milisegundos de placa a cada token, y las 16.384 posiciones ocupan medio giga de placa que antes eran expertos. Con la configuración del servicio, el motor genera un 8 % más lento que anoche.

## La primera charla

Esta noche abrí el Open-WebUI y elegí el motor. Escribí un mensaje de cien caracteres, y al motor le llegó un prompt de 6.651 tokens. Leerlo llevó seis minutos.

Le pedí diez páginas web completas, todas distintas. Escribió tres enteras, a 16 tokens por segundo, y en la cuarta se quedó sin lugar: los 6.651 tokens del pedido y 9.713 de respuesta llenan las 16.384 posiciones. No era una falla. Era un pedido que no entraba.

**¿Qué eran los otros 6.500 tokens?**

Las descripciones de 36 herramientas del Open-WebUI: buscar en mis documentos, en mis chats y en mis memorias, la fecha, preguntarme algo. Las manda en cada pedido, y la plantilla del modelo las escribe al principio del prompt. Para un servicio en la nube son centavos. Para un motor que lee a veinte tokens por segundo son seis minutos. El frente ahora las ignora: el mismo tipo de mensaje llegó como 24 tokens, el motor lo leyó en un segundo y la respuesta empezó a los veinte, después de otra tarea que el Open-WebUI le pide al modelo antes de contestar. Las herramientas no las usaba. El costo lo pagaba igual.

## El cuaderno, abierto

Todo esto está en [pasada](https://github.com/BaldrVivaldelli/pasada). Está el código del motor y del servidor, y está el guion de cada medición, con las líneas exactas que se corrieron. Están también los resultados crudos y un informe por etapa, de la primera medición de OLMoE hasta la charla de esta noche.

No es un programa para instalar: corre un solo modelo, por Vulkan, y se probó en una sola PC. Es un cuaderno de laboratorio. Claude escribió los informes para mí mientras trabajábamos, en castellano y de vos, y los dejé como están: cuentan también lo que salió mal y las veces que hubo que corregir un informe anterior. El README dice cómo reproducirlo: llama.cpp en un commit fijo con un parche, el motor y los cuatro archivos del modelo.

## Lo que me llevo

Seis reglas.

**Lo que se olvida elige mejor que lo que se rotula.**  
Los expertos son mezclas. Una cuenta que se olvida sigue lo que el texto usa, sin saber qué es un tema.

**Asincrónico en la interfaz no quiere decir asincrónico en el dispositivo.**  
La espera estaba escrita como una y eran cinco. Se encuentra midiendo, no leyendo el código propio.

**El reloj es parte del programa.**  
Lo que parecía un kernel lento era una placa dormida. Un motor que deja la placa esperando paga el arranque en frío en cada capa.

**La vara cambia con el camino.**  
Bit a bit mientras se hace el mismo trabajo en el mismo lugar. Fiel, con la regla escrita antes, cuando el trabajo cambia de dispositivo.

**Rápido y mal es lo primero que hay que sospechar.**  
Las tandas iban cuatro veces más rápido porque calculaban de menos. La calidad lo dijo antes que yo.

**Juntar trabajo rinde lo que el trabajo se repite.**  
Dieciséis tokens seguidos casi no comparten expertos. Una tanda reparte el costo de lo que se repite y nada más.

*Como siempre: casi todo el código lo escribió Claude, que también corrió las mediciones y escribió los informes. La dirección, las preguntas y las decisiones fueron mías, y la idea de descartar los expertos de los temas que se dejan también. La idea no salió como la pensé, y el resultado fue mejor.*
