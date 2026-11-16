# El universo correcto

*Me puse a investigar Strata, un motor que corre un modelo de más de cien mil millones de parámetros en una PC gamer, y quise entenderlo desde el teorema antes que desde el código. Empecé con siete teoremas en Lean que compilaban y no decían nada. Terminé con cincuenta y seis, una identidad de Bourbaki formalizada en Mathlib y una medición sobre los pesos reales que cerró la última pregunta en contra. Esta nota es el camino, con los dos desvíos y el no final incluidos.*

[Strata](https://github.com/mach10x/strata) es un motor de inferencia para una familia de modelos *mixture of experts*: 24.576 expertos chicos repartidos en 48 capas, de los que cada token usa diez por capa. La placa de video guarda los expertos que más se piden, la RAM los guarda todos, y la CPU calcula los que no están en la placa mientras la GPU calcula los que sí. Una opción, `--pcie-frac`, manda una parte de los faltantes por PCIe a la GPU en vez de calcularlos en la CPU. Todo eso en una máquina con una RTX 5070 y 64 GB de RAM, a 93 tokens por segundo.

Me pareció de las cosas más interesantes que vi en el año, y quise meterme por el lado que me gusta: ¿qué de todo esto es un teorema?

Como en las notas anteriores, Claude escribió casi todo el código y casi todas las demostraciones. Las preguntas, los rechazos y la dirección fueron míos. Esta vez los rechazos importaron más que de costumbre.

**¿Dónde está el universo en el que una política de caché es óptima?**

Esa fue la pregunta que ordenó todo. Lo que sigue son cuatro intentos de responderla, cada uno más adentro de Lean que el anterior.

## Siete teoremas que no decían nada

Arranqué solo. Tres archivos Lean, siete teoremas, todos con demostraciones de una línea: `ring`, `linarith`, `norm_num`, `decide`. Una identidad de ahorro esperado, una monotonía del costo, un contraejemplo de que el experto más frecuente no es el de mayor utilidad, una cota de regret de $$2\delta$$ para una decisión con predicción, y un ejemplo de camino crítico donde reducir trabajo no reduce latencia.

Compilaban. Sin `sorry`, con los axiomas de siempre. Y cuando los miré con un poco de distancia, el problema era obvio: ninguno mencionaba un experto, un caché ni un router. Eran aritmética de reales. Todo el contenido sobre modelos vivía en los docstrings y en el README, no en Lean. Lean verificaba la cuenta, no el modelo.

Peor: el único teorema con filo, el contraejemplo de frecuencia, necesitaba que un experto ahorrara nueve veces más por pedido que otro. En el modelo que corre Strata todos los expertos ruteados tienen la misma forma. Con ahorro uniforme, la utilidad es la frecuencia multiplicada por una constante, y la política de frecuencia es exactamente la óptima. Había refutado una política que Strata no usa.

**Un teorema sin modelo es aritmética.** Primera regla, y la más barata de aprender.

## El modelo adentro de Lean

La segunda versión puso el modelo como objeto de Lean. Cuatro costos por capa: $$a$$, el trabajo de GPU que ocurre siempre, atención, router, experto compartido; $$g$$, GPU por experto cacheado; $$c$$, CPU por experto faltante; $$x$$, PCIe por experto. La latencia de una capa, con CPU y GPU en paralelo:

$$
L(h, m) = \max(a + g\,h,\; c\,m)
$$

donde $$h$$ son los aciertos y $$m$$ los faltantes. Y el ruteo como una distribución finita sobre *conjuntos* de expertos pedidos por token, no sobre expertos sueltos. Esa decisión fue la que después dio resultados: un perfil de uso mide marginales, pero la latencia depende de qué expertos fallan juntos.

Con eso salieron teoremas que sí hablan de algo:

- En el régimen donde la CPU es el cuello de botella en todos los escenarios, más aciertos es menos latencia. La frecuencia es óptima ahí, y Strata tiene razón.
- En el régimen donde la GPU es el cuello, más aciertos es *más* latencia. Cada experto que se suma a la placa le agrega exactamente $$g$$.
- Entre los dos, el valor de un lugar en la placa depende de qué lado es crítico en esa capa, no de la frecuencia del experto.

Y el contraejemplo correcto, el que no necesita ahorros distintos. Cuatro expertos iguales, dos por token, dos lugares en la placa, y el trabajo fijo de la GPU igual al costo de un experto en CPU, así que el primer faltante sale gratis. La distribución conjunta: el par $$\{a,b\}$$ el 40 % de las veces, $$\{c,d\}$$ el 30 %, $$\{a,c\}$$ el 15 %, $$\{b,d\}$$ el 15 %.

| Caché | Tasa de aciertos | Latencia esperada |
|---|---|---|
| $$\{a,b\}$$, por frecuencia | 1,10 | 1,30 |
| $$\{a,d\}$$, por cobertura | 1,00 | 1,00 |

El caché por frecuencia tiene la mejor tasa de aciertos de los dieciséis subconjuntos posibles y la peor latencia de los dos. El caché que cubre todos los pares tiene menos aciertos y es óptimo. Lo decide el kernel de Lean sobre racionales, recorriendo los dieciséis subconjuntos.

Un detalle que me costó una compilación: sobre $$\mathbb{Q}$$, `decide` a secas no cierra, porque las operaciones de los racionales son irreducibles para el elaborador. Hay que usar `decide +kernel`, que evalúa en el kernel y no agrega axiomas.

## Piso y techo

Lo siguiente fue preguntar cuánto se puede ganar, en el mejor caso, dentro de ese universo. La respuesta es un par de teoremas cortos: ninguna ubicación de expertos baja la latencia esperada de $$a$$ por capa, el trabajo fijo de la GPU, y ninguna la sube de eso más $$g\,h + c\,m$$. Todo lo que cualquier política de caché puede ganar es un factor constante sobre el piso.

Eso no es una mala noticia. Es un mapa. Si quiero una mejora de otro orden, tengo que cambiar el universo, no la política.

## El desvío

Acá viene el primer rechazo, y lo cuento porque fue parte del método.

Cuando pregunté por alternativas que dieran una mejora exponencial, la primera respuesta que recibí fue una red: repartir los expertos entre los dispositivos de un barrio, celulares y PCs viejas, y que la red fuera la computadora. Tenía su matemática, incluso reusaba el modelo de co-ocurrencia como localidad.

Dije que no. No quería trasladar nada a una red. La pregunta real era otra: una sola PC, una CPU y una GPU doméstica, ya tiene miles de unidades de cómputo en paralelo. El álgebra de Boole nos enseñó hace décadas que el cómputo se reparte entre muchas ALU. ¿Por qué una PC sola no rinde como un servidor?

La respuesta a esa pregunta fue la tercera versión.

## Una sola caja

El cambio de unidad fue el cambio de todo. En vez del token, la *pasada*: un viaje por las 48 capas que lleva $$B$$ tokens a la vez. Pueden ser borradores de decodificación especulativa, ramas paralelas de un mismo razonamiento, trozos de prompt, o pedidos de otras personas. Una pasada mueve bytes por el bus de RAM, gasta FLOPs y no puede ser más corta que su cadena de dependencias. Dividir por $$B$$ da el tiempo por token.

Lo que gobierna cuánto rinde el paralelismo son dos cotas, y las dos quedaron como teoremas con parámetros: la de Brent, que dice que el tiempo no baja de trabajo sobre procesadores ni de profundidad, y el roofline, que dice que no baja de bytes sobre ancho de banda.

Con un token por vez, y con los números de la tabla de abajo, la máquina hace unos 30 FLOP por cada byte que cruza el bus de RAM: 6 GFLOP sobre 210 MB. Para que la GPU no espere al bus harían falta 500, sus 30 TFLOPS sobre los 60 GB/s de la RAM. El 94 % de las ALU está ociosa. No faltan ALU; falta trabajo independiente por cada byte movido. Los teoremas de la tercera versión dicen cuándo se recupera: pasado cierto $$B$$, una pasada lee el modelo residente en RAM una sola vez, lleve los tokens que lleve, y pasado otro $$B$$ mayor la caja queda limitada por cómputo, exactamente como un servidor.

Los órdenes de magnitud para la máquina de la tabla de Strata, y acá subrayo que son **estimaciones, no mediciones**: RAM a 60 GB/s, GPU de 30 TFLOPS, modelo de 38 GB de los que 26 quedan fuera de la placa, un token solo trae unos 210 MB de RAM y gasta unos 6 GFLOP.

| Régimen | Tokens por pasada | Tiempo por pasada | Tokens por segundo |
|---|---|---|---|
| Strata hoy | ~3 | ~30 ms | 93 |
| Piso con un token | 1 | ~3,5 ms | ~280 |
| Saturación del bus | ~125 | ~0,43 s | ~290 |
| Lote grande | 512 | ~0,43 s | ~1.200 |
| Límite de cómputo | ~2.200 | ~0,43 s | ~5.000 |

PCIe 4.0, a unos 26 GB/s, queda por debajo del bus de RAM: si todos los faltantes viajan a la GPU, pasa a ser el piso y el lote grande rinde unos 500 tokens por segundo. Y en una sola caja la CPU y el PCIe leen la misma RAM, así que el reparto entre los dos nunca baja el piso del bus. Eso corrigió un teorema de la segunda versión que los trataba como trabajadores independientes.

Un hilo conversacional solo, entonces, no pasa de unos 280 tokens por segundo en esa placa. El salto de trece a cincuenta veces es trabajo paralelo útil.

## Lo frena el teorema

Segundo rechazo. No compartí que fuera la profundidad lo que frenaba. Lo que frenaba era el teorema: la forma en que se había reducido la ecuación. Los modelos de recursos, Brent, roofline, son de gente que resuelve las cosas de forma no algebraica. Si uno quiere las reducciones correctas, tiene que ir a buscarlas donde están escritas con rigor: Bourbaki, *Algèbre*, capítulos I a III.

La concesión que siguió fue precisa, y creo que es el centro de la nota. Los pisos de la tercera versión son teoremas sobre cuatro parámetros: bytes por token, bytes del modelo, trabajo por token, profundidad. Nada en ellos dice que los parámetros sean fijos. Una identidad algebraica que reescribe el cómputo en otro igual, con menos bytes, menos multiplicaciones o una cadena más corta, mueve el piso. Quedó como teorema: el piso es monótono en los cuatro.

**Los pisos son parámetros.** Lo que parecía una pared era una función.

## Las reducciones

La cuarta versión es una lista de identidades exactas, cada una con la ley de Bourbaki que la produce y el parámetro que mueve.

| Reducción | Ley | Mueve | Exacta sobre pesos ya entrenados |
|---|---|---|---|
| Soporte: el producto punto sólo toca pesos donde la activación no es cero | Cap. I, soporte de una función | Bytes | Sí con cero exacto; aproximada con umbral |
| Libro de códigos: una multiplicación por código, no por peso | Cap. I, distributividad sobre una imagen finita | Multiplicaciones | Sí. Es el kernel por tabla, y con dos bits es álgebra de Boole sobre las entradas |
| Recurrencia afín: $$B$$ pasos son un solo mapa; con asociatividad, un árbol de profundidad $$\log_2 B$$ | Cap. I §1, monoide de mapas afines | Profundidad | Sí, en las capas lineales sobre el lote de borradores |
| Producto tensorial: $$n^2 + m^2$$ parámetros en lugar de $$(nm)^2$$ | Cap. II §3 | Bytes y FLOPs | No: la estructura se entrena, no se encuentra |

Las tres primeras valen sobre el modelo tal como viene y dan factores constantes. El cambio de clase, de $$n^2$$ a algo mucho menor, sale sólo de la cuarta familia: pesos que viven en un producto tensorial. Esa estructura no se descubre en pesos densos ya entrenados; se impone al entrenar. Bourbaki lo formula bien: primero decidís en qué módulo viven los pesos, después la reducción es un teorema, no un hallazgo.

Entonces pedí la identidad de Kronecker, formalizada con el producto `⊗ₖ` de Mathlib. Salió así:

$$
(A \otimes B)\,\mathrm{vec}(X) = \mathrm{vec}(B\,X\,A^{\mathsf T})
$$

La matriz grande $$A \otimes B$$ nunca se forma: el mismo vector sale de dos productos chicos. Es exacta para toda $$A$$, $$B$$ y $$X$$, con índices rectangulares arbitrarios. Por linealidad se extiende a una suma de $$r$$ términos de Kronecker, que es la forma de la aproximación de Van Loan y Pitsianis de un peso entrenado. Y un corolario la encadena con el piso de la caja sola: expertos con estructura tensorial nunca suben el piso, para todo tamaño de lote.

Los números, en la aritmética del modelo, para una matriz de experto de 2560 por 640, la forma real de los expertos de este modelo, con factores de 64 por 16 y 40 por 40:

| | Densa | Un término de Kronecker | $$r$$ términos |
|---|---|---|---|
| Números guardados | 1.638.400 | 2.624 | 2.624 · $$r$$ |
| Multiplicaciones por token | 1.638.400 | ~66.600 | ~66.600 · $$r$$ |

Los bytes caen $$624 / r$$ y las multiplicaciones $$25 / r$$. Como en la caja sola el costo son los bytes del bus, con $$r = 8$$ el piso del modelo baja unas 78 veces. Ahí aparece el salto de orden que buscaba, y la monotonía lo convierte en teorema. Todo cuelga de un número: $$r$$.

Dos trampas de Lean que quedaron anotadas. Las instancias `Fintype` de una sección se cuelan en los lemas aunque no se usen, y después piden una instancia donde no existe; `omit ... in` lo arregla. Y las definiciones que dividen reales tienen que ser `noncomputable`, aunque uno nunca las vaya a ejecutar.

## Lo que medí

La identidad es exacta. La aproximación de un peso denso ya entrenado por $$r$$ términos tiene error, y ese error es la cola de valores singulares de la matriz reacomodada de cada experto, el reacomodo de Van Loan y Pitsianis. Eso ya no es un teorema: es un cálculo sobre los pesos reales.

El modelo en BF16 pesa 354 GB y mi conexión baja a unos 5 MB por segundo, así que el script no baja el modelo: parsea el encabezado de cada archivo y pide por rangos HTTP sólo los bytes de los expertos que muestrea. Veinte expertos de cinco capas, las tres matrices de cada uno, seis formas de factores, unos 200 MB en total. Como referencia, las mismas formas sobre matrices de ruido gaussiano puro.

| | Términos máximos | $$r$$ al 99 % de la energía | Error con 8 veces menos números |
|---|---|---|---|
| Expertos reales, Kronecker | 1.280 | 986 | 0,889 |
| Ruido gaussiano, Kronecker | 1.280 | 987 | 0,889 |
| Expertos reales, rango bajo | 640 | 615 | 0,87 a 0,89 |
| Ruido gaussiano, rango bajo | 640 | 618 | 0,897 |

**$$r$$ es el máximo.** Mirado con Kronecker, un experto entrenado es indistinguible de ruido hasta la tercera cifra, en las cinco capas, en los veinte expertos, en las seis formas. Con ocho veces menos números, el error relativo es 0,889: la aproximación recupera apenas una quinta parte de la energía de la matriz. La única señal es una de rango bajo, débil: unas quince direcciones menos que el ruido sobre 640. Otro modelo de otra familia, OLMoE, da exactamente lo mismo.

Eso explica algo que ya sabíamos sin saber por qué: la cuantización a dos o tres bits funciona y la factorización no. La información por entrada es baja, pero está repartida por todas las direcciones. La compresión tiene que ser por entrada, bits, libros de códigos, soporte, y no estructural. De las cuatro reducciones de la tabla, la medición mata la cuarta sobre pesos publicados y deja las tres exactas, que son constantes. El salto de orden se decide al entrenar, y la identidad de Kronecker queda como la especificación exacta de qué entrenar.

Para Strata tal como viene, entonces, la palanca grande en una sola PC vuelve a ser la de la tercera versión: tokens por pasada.

## Lo que me llevo

Cinco reglas, esta vez.

**Un teorema sin modelo es aritmética.**  
Si los expertos, los cachés y el router viven en los docstrings, Lean verifica la cuenta y nada más.

**La frontera de una política es el régimen.**  
La frecuencia es exactamente óptima cuando la CPU es el cuello, y exactamente contraproducente cuando lo es la GPU. No hay política buena sin saber de qué lado está el camino crítico.

**Los pisos son parámetros.**  
Brent y roofline no son paredes. Son funciones de bytes, trabajo y profundidad, y el álgebra mueve los argumentos.

**La estructura se decide antes de entrenar.**  
Las reducciones exactas sobre pesos ya entrenados dan constantes. El cambio de orden está en el módulo donde viven los pesos, y eso se elige antes. Lo medí sobre los pesos reales: un experto entrenado, mirado con Kronecker, es ruido.

**`decide` no es `decide +kernel`.**  
Sobre racionales, el elaborador no reduce; el kernel sí. Vale lo mismo para cualquier teorema que sea una tabla.

## Lo que sigue

Lo que no pude medir sin Strata corriendo en una máquina que lo aguante: el tiempo real por pasada contra el piso de 3,5 ms, la longitud de aceptación del árbol especulativo, el soporte de la activación después de la compuerta, y el exponente de la ley de potencias del uso de expertos, que decide si el modelo puede crecer en disco sin tocar la placa. El perfil que Strata publica es un ranking sin conteos; hacen falta trazas del router.

Y los dos pedazos que quedaron sin formalizar: la secuencia de 48 capas como suma de máximos, y la cota del conjunto de trabajo bajo una ley de potencias.

Lo que hice después con la palanca de tokens por pasada, en mi propia notebook, está en la nota siguiente. El proyecto Lean y el script de medición son locales por ahora.

*Como siempre: casi todo el código y casi todas las demostraciones las escribió Claude. La dirección, las preguntas, y sobre todo los dos "no" de esta nota, fueron míos.*
