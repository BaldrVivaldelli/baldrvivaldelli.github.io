# El trabajo que nadie reparte

*Llevé la tesis de mure a un enjambre de agentes de código: varios agentes construyendo el mismo cambio, sin un coordinador que reparta el trabajo. Lo que se sostuvo, lo que se rompió, lo que costó, y lo que el sistema promete escrito en serio.*

Baldr es mi plano de control local para agentes. Recibe un pedido, arma un plan, lo implementa y lo revisa con modelos de distintos proveedores, y deja todo en un estado durable que sobrevive a un `kill -9`. Hasta ahora lo hacía en fila: un arquitecto, un implementador, un revisor.

La pregunta de esta vez fue otra:

**¿pueden varios agentes construir el mismo cambio a la vez, sin que nadie reparta el trabajo?**

La respuesta corta es que sí, y que lo difícil no estuvo donde lo esperaba.

Como con mure, buena parte del código la escribió Claude. La dirección, el diseño, las propiedades que tenían que sostenerse y la decisión de qué medir fueron mías. Y, otra vez, la mejor fuente de ideas no fue un framework de agentes: fue un protocolo de hace veinte años.

## La misma tesis, otro sistema

La primera entrada de la bitácora de mure dice que el enjambre es durable para los *datos*, no para la *ejecución*. Lo que la distribución regala es poder volver a derivar las cosas, y eso abarata todo lo demás: un journal mínimo, el resto efímero, y una sola forma de recuperarse, que es arrancar.

En BitTorrent una pieza está completa cuando su hash coincide. No importa qué peer la mandó ni qué dijo sobre ella.

En el enjambre de agentes, una pieza está hecha cuando su chequeo pasa sobre el trunk que la contiene:

$$
\mathit{hecha}_i \iff \exists\, t:\ \Delta_i \sqsubseteq T_t \ \wedge\ \mathit{check}_i(T_t) = 0
$$

donde $$T_t$$ es el trunk en el instante $$t$$ y $$\Delta_i$$ el cambio de la pieza. No cuenta lo que el agente dice que hizo. Su reporte es un dato más, como el `have` de un peer: útil, pero no autoridad.

Con eso, lo durable quedó en tres cosas:

- **el plan**, inmutable y nombrado por su digest, como un torrent por su info-hash;
- **el trunk**, una rama privada de Git con un commit por pieza integrada;
- **el journal de intentos**, que dice qué pasó y cuánto costó.

Todo lo demás se puede perder sin perder nada: quién está trabajando en qué, qué trabajador sigue vivo, qué pieza conviene tomar.

## Nadie reparte

En BitTorrent no hay un servidor que le diga a cada peer qué pedir. Cada uno mira lo que tiene, lo que le falta y lo que ofrecen los demás, y decide. El tracker es un punto de encuentro, no un jefe.

El enjambre de Baldr funciona igual:

- **Cada trabajador decide solo.** Mira las piezas libres y toma la que más piezas desbloquea, el equivalente a pedir primero lo raro. El desempate es aleatorio, para que dos trabajadores que deciden en el mismo instante no se amontonen sobre la misma.
- **Reclamar es exclusivo.** Una pieza se reclama con compare-and-set en SQLite y vive mientras su lease. Si el trabajador muere, no hay nada que limpiar: el lease vence y otro la toma. Que el reclamo sea exclusivo hace que un fallo tenga un único responsable, como en mure una pieza corrupta culpa al único peer que la sirvió.
- **Integrar es una fila india.** Cada pieza se aplica sobre la punta del trunk y se vuelve a chequear ahí, porque otra pieza integrada antes pudo haber cambiado algo que esta usa.
- **Terminar es un predicado.** Que todo esté hecho, que el run se haya pasado de presupuesto o que se haya estancado lo puede evaluar cualquier trabajador. El primero que lo ve actúa, y el compare-and-set garantiza que sea uno solo.
- **El estancamiento se declara, no se disimula.** Si no queda nada que se pueda construir y nadie está trabajando, el run lo dice, con su progreso parcial.

SQLite cumple el papel del tracker. Guarda hechos y reclamos. Nadie lee de ahí para decidir por otro.

## Las piezas no son bytes (pero pueden serlo)

El primer borrador del diseño decía que acá la analogía se rompía: dos piezas de un torrent nunca escriben el mismo byte, pero dos subtareas de código sí pueden tocar el mismo archivo.

No me convenció. Las escrituras de un agente se pueden hacer disjuntas. La diferencia es de dónde sale la disjunción: en un torrent viene dada, porque los rangos de bytes existen antes de que alguien baje algo; en código es una predicción del plan, y un agente puede descubrir a mitad de camino que necesita otro archivo.

Entonces no se espera, se hace cumplir. Cada pieza $$p$$ es dueña de un conjunto de rutas $$D_p$$, y su cambio se rechaza si toca algo afuera:

$$
\mathit{rutas}(\Delta_p) \not\subseteq D_p \implies \Delta_p \text{ se descarta}
$$

igual que una pieza con el hash equivocado. Y el plan encadena a dos piezas cuyos dueños se pisan, así que nunca están en vuelo a la vez:

$$
D_p \cap D_q \neq \emptyset \implies p \prec^{*} q \ \vee\ q \prec^{*} p
$$

donde $$\prec^{*}$$ es la clausura transitiva de "usa a".

Con eso sale un lema que hace todo el resto posible. Si dos cambios tocan rutas disjuntas, aplicarlos conmuta:

$$
\mathit{rutas}(\Delta_p) \cap \mathit{rutas}(\Delta_q) = \emptyset \implies (T \oplus \Delta_p) \oplus \Delta_q = (T \oplus \Delta_q) \oplus \Delta_p
$$

y ninguno de los dos órdenes produce conflicto. Es la propiedad del diamante: el contenido del trunk después de integrar un conjunto de piezas disjuntas no depende del orden en que llegaron. Por eso integrar puede ser una fila india sin que importe quién llegue primero.

Lo que el lema *no* dice es que los chequeos compongan:

$$
\mathit{check}_p(T \oplus \Delta_p) = 0 \ \wedge\ \mathit{check}_q(T \oplus \Delta_q) = 0 \ \not\Longrightarrow\ \mathit{check}_p(T \oplus \Delta_p \oplus \Delta_q) = 0
$$

Las escrituras son disjuntas; la *lectura* no. En un torrent la pieza 5 es correcta sin importar la 6. En código, una pieza puede usar lo que otra cambió. Por eso cada pieza se vuelve a chequear sobre el trunk cuando se integra, y hay un chequeo del repositorio entero antes de publicar, que cumple el papel del SHA-256 del archivo completo contra el oficial:

$$
\mathit{publicar}(T) \implies \mathit{check}_{\mathrm{final}}(T) = 0
$$

Que dos agentes iteren sobre el mismo archivo es otra cosa: a efectos prácticos, es un Paxos. La propiedad de archivos es la versión con un solo proponente, que esquiva el problema en vez de resolverlo. Quedó para otro día, a propósito: primero quería armar algo y ver cómo salía.

## Lo que el enjambre promete, escrito en serio

En mure aprendí que las propiedades se escriben en el momento en que se toma la decisión, no después. Acá van las del enjambre, separadas como las separa la verificación formal desde Lamport: **seguridad**, que nada malo pase nunca, y **vivacidad**, que algo bueno termine pasando.

El estado, por pieza $$i$$: si está abierta o hecha, quién la reclama, $$\mathit{due\tilde{n}o}_i \in W \cup \{\bot\}$$, hasta cuándo, $$\mathit{vence}_i$$, y cuántos intentos lleva, $$a_i$$. Un reclamo está vivo mientras no venció:

$$
\mathit{vivo}_i(t) \iff \mathit{due\tilde{n}o}_i \neq \bot \ \wedge\ t < \mathit{vence}_i
$$

### Seguridad

**S1. Solo integra quien tiene el reclamo.** Si un trabajador integra una pieza, en ese instante es su dueño:

$$
\Box\ \big(\mathit{integra}(w, i) \Rightarrow \mathit{due\tilde{n}o}_i = w\big)
$$

Se sostiene porque reclamar e integrar son, cada uno, una transacción `BEGIN IMMEDIATE` de SQLite: las escrituras quedan serializadas, y cada una es un compare-and-set. Reclamar exige que no haya un reclamo vivo; integrar exige seguir siendo el dueño. Si el lease de un trabajador venció mientras pensaba y otro tomó la pieza, su integración falla y su trabajo se descarta. Si nadie la tomó, integra igual, y está bien: nadie más la estaba construyendo.

**S2. Hecha significa verificada.** Es la definición de arriba, y vale como invariante porque la única transición que marca una pieza como hecha es la que acaba de correr su chequeo sobre el trunk.

**S3. Un solo escritor.** Nunca dos piezas en vuelo comparten dueños, y la carpeta de la persona tiene un único escritor, la publicación:

$$
\Box\ \forall p \neq q:\ \big(\mathit{vivo}_p \wedge \mathit{vivo}_q\big) \Rightarrow D_p \cap D_q = \emptyset
$$

### Vivacidad

Lo que quiero es que el run termine, de una de tres formas:

$$
\Diamond\ \big(\mathsf{publicado} \vee \mathsf{estancado} \vee \mathsf{fallido}\big)
$$

bajo equidad débil de los trabajadores: si un trabajador puede dar un paso todo el tiempo, alguna vez lo da.

La demostración es una función de rango, la herramienta clásica para probar que algo termina: una cantidad que vive en un orden bien fundado y baja con cada paso. Con $$A$$ intentos por pieza y $$R$$ enmiendas del plan como máximo, sea

$$
V = \Big(R - r,\ \ \sum_{i\ \text{abierta}} (A - a_i),\ \ \big|\{i : i\ \text{abierta}\}\big|\Big)
$$

ordenada lexicográficamente en $$\mathbb{N}^3$$. Cada intento que cuenta consume un intento o cierra una pieza, y baja la segunda o la tercera componente. Una enmienda del plan puede reabrir piezas y subir las otras dos, pero baja la primera, que manda. Como $$\mathbb{N}^3$$ con el orden lexicográfico no tiene cadenas descendentes infinitas, hay finitos intentos, y en algún momento no queda pieza reclamable: o están todas hechas, y se publica, o el run está trabado.

**Pero la demostración tiene un agujero, y conviene mirarlo de frente.** Hay un resultado que devuelve el intento sin consumirlo: el rate limit de un proveedor. Ese paso deja $$V$$ igual. Un proveedor que limita para siempre mantiene al run dando vueltas sin bajar nada, y el tope de gasto tampoco lo frena, porque un intento limitado no gasta. La propiedad vale solo con una hipótesis sobre el mundo:

$$
\Box\Diamond\ \neg\,\mathit{limitado}
$$

el proveedor, alguna vez, contesta. Es honesto que esté escrita. Lo que no está escrito, uno lo descubre a las tres de la mañana.

### Trabado es estable

El run se declara estancado cuando no hay nada libre, nadie trabajando y algo sin hacer:

$$
\mathit{trabado} \iff \neg\exists i\ \mathit{libre}_i \ \wedge\ \neg\exists i\ \mathit{vivo}_i \ \wedge\ \exists i\ \text{abierta}_i
$$

Y es un **predicado estable**: una vez verdadero, sigue siéndolo,

$$
\Box\,\big(\mathit{trabado} \Rightarrow \Box\, \mathit{trabado}\big)
$$

porque toda transición que puede liberar una pieza o cambiar el plan la da un trabajador con un reclamo vivo, y no hay ninguno. Para propiedades estables hay un resultado viejo y lindo, de Chandy y Lamport: si se cumplen en una foto consistente del sistema, se cumplen después. Acá la foto es una sola transacción de SQLite, que es consistente por construcción. Por eso declarar el estancamiento desde un único trabajador, sin preguntarle a nadie, es seguro.

## Las corridas

Probé contra repositorios de juguete, a propósito: quería poder leer cada línea de lo que salía.

El segundo, `mdlite`, es un renderer de Markdown mínimo con 20 tests de aceptación escritos antes y que ningún agente puede tocar. Las features se acoplan a propósito: el código inline no se interpreta, los escapes van antes que el énfasis. Antes de gastar un peso, validé que los tests se pudieran cumplir con una implementación propia que no entró al repo.

| Corrida | Tiempo | Costo | Qué pasó |
|---|---|---|---|
| `textkit`, 4 piezas | 49 s | US$0,57 | Todo al primer intento. |
| `mdlite`, 6 piezas | 2m19s | US$0,94 | La integración necesitó dos intentos y no quedó registro de por qué. |
| `mdlite`, con historial y chequeo propio | 7m24s | US$0,80 | Todo al primer intento, pero una pieza quedó colgada seis minutos. |
| `mdlite`, con el shell arreglado | 1m39s | US$0,90 | Todo al primer intento. |
| `mdlite`, con arranque escalonado | 1m36s | US$0,71 | Todo al primer intento. |
| `mdlite`, con re-plan | 2m48s | US$1,14 | La integración devolvió la contradicción; el arquitecto reabrió dos piezas. |

Tres trabajadores, Claude Sonnet, y el costo es el que informa el CLI. Las cinco piezas independientes de `mdlite` salen en dos tandas, a unos 30 segundos por pieza; la integración espera a las cinco.

Lo interesante no está en la tabla. Está en lo que se rompió entre una fila y la siguiente.

## El agente trae tu shell

La corrida de 7 minutos tenía una pieza que había terminado su trabajo y no salía.

El Bash de Claude Code carga una foto del shell de quien lo lanza, con sus alias incluidos. En mi máquina, `ls` es `eza`. El agente corrió un `ls`, Claude lo mandó a segundo plano con la entrada conectada a un socket, y `eza` se quedó esperando leer de ahí. Claude, en modo no interactivo, espera a sus tareas de fondo antes de salir. El trabajador, mientras tanto, renovaba el reclamo de la pieza con toda la buena fe del mundo.

En términos de la sección anterior, fue una violación de vivacidad que ninguna propiedad de seguridad podía ver: nada malo pasaba, solo que nada bueno pasaba tampoco.

El arreglo tiene dos partes:

- **El agente corre en un bash sin mi configuración.** Lo verifiqué con una prueba barata: con mi zsh, `type ls` dice que es un alias de `eza`; con bash, `/usr/bin/ls`. De paso, el agente ya no hereda la identidad de una sesión de Claude Code que haya lanzado a Baldr.
- **Cada pieza tiene un tope de tiempo.** Si lo pasa, se mata su árbol de procesos y la pieza vuelve al pool. Un agente colgado cuesta un intento, no el run, y el intento consumido es justo lo que necesita la función de rango para seguir bajando.

La lección es más general que el alias: el entorno del agente es parte del sistema. Si no lo construís vos, lo construye la máquina de quien lo corre.

## El plan también puede mentir

En `mdlite`, el arquitecto escribió los contratos entre piezas en prosa, dentro de los objetivos: unos marcadores que las piezas de escapes y de código tenían que compartir sin verse. Cinco piezas en paralelo se pusieron de acuerdo leyendo esa prosa, y funcionó.

Lo que no funcionó fue una contradicción del propio plan. Decía que la pieza de enlaces escapaba las URLs, y también que el pipeline escapaba todo el HTML antes. Las dos cosas juntas escapan dos veces: el contraejemplo exacto de que los chequeos no componen.

Dos corridas distintas, con agentes distintos, terminaron con el mismo arreglo: la pieza de integración, que no puede tocar el archivo de enlaces, agregó en el suyo una función que deshace el escape. Pegamento. Es lo que la propiedad de archivos produce cuando el error está en otra pieza: el que lo encuentra no puede arreglarlo en su lugar, así que lo compensa desde afuera.

El arreglo fue darle a la contradicción un camino de vuelta. Una pieza que encuentra el plan contradictorio ya no lo compensa: se detiene y lo reporta, y ese intento no cuenta en su contra. El run deja de repartir piezas, el arquitecto recibe el plan, lo que ya está integrado y el reporte, y devuelve una versión nueva del plan con su propio digest. Las piezas que no cambian conservan lo que tienen; las que cambian se reabren, y cualquier reclamo sobre ellas caduca. Una pieza ya integrada no se puede borrar: su commit está en el trunk.

En la corrida real, la integración se detuvo y escribió: "render_links escapa la URL, pero el plan ejecuta escape_html sobre todo antes". El arquitecto reabrió la pieza de enlaces y la de integración, conservó las otras cuatro, y la versión final no tiene una sola línea que deshaga un escape.

Un contrato en prosa es un contrato sin compilador. Lo mínimo es que, cuando alguien encuentra el error, el error vuelva a quien lo escribió.

## Los tests escribieron en mi casa

Esta no es del enjambre, pero salió mientras lo construía, y es la que más me incomodó.

La suite de tests de Baldr aislaba el entorno solo cuando las variables XDG no estaban definidas. Daba por hecho que, si estaban, alguien ya lo había aislado. Mi sesión de escritorio exporta `XDG_STATE_HOME`, que apunta a mi `~/.local/state` real.

Correr `pytest` directo aplicó a mi base real de Baldr tres migraciones de branches sin mergear, y dejó backups y artifacts de prueba en mi directorio de estado. Peor: el barrido de huérfanos del garbage collector, corrido contra una base de prueba, borraba del directorio real cualquier archivo que esa base no reconociera. Es decir, todos los míos. Mi base todavía tiene las filas de 40 artifacts grandes de septiembre; los archivos ya no están. La base la pude restaurar desde un backup que ella misma había hecho antes de la primera migración ajena. Los archivos, no.

El arreglo fue corto: la suite usa siempre su propio directorio descartable, salvo que el runner oficial le avise explícitamente que ya armó uno. Lo que me quedó fue la pregunta: un test que confía en el entorno no está aislado, está de suerte.

## El costo está en el arranque

Cuando miré adónde se iban los dólares, esperaba encontrar el trabajo de los agentes. Encontré el arranque.

Cada pieza hace entre cinco y seis llamadas al modelo. Cada invocación nueva de Claude empieza con unos $$F \approx 23\,000$$ tokens de contexto: prompt de sistema, herramientas y nuestro pedido. De esos, un prefijo $$P \approx 13\,500$$ se puede compartir entre invocaciones a través de la cache de prompts; el resto, $$U = F - P$$, se vuelve a escribir en cada invocación, aunque la carpeta y el pedido sean idénticos.

Me acordé de Tungsten, el proyecto con el que Spark atacó un problema parecido. No resolvió ningún teorema: hizo un diagnóstico. El cuello de botella se había mudado a la CPU, y en el modelo clásico de iteradores cada operador le pide al siguiente fila por fila, pagando una llamada virtual por fila. La generación de código de etapa completa funde la cadena de operadores en un solo loop.

Acá cada pieza paga su arranque como cada fila pagaba su llamada. Para razonarlo hace falta un poco de aritmética. Escribir en la cache cuesta $$c_w$$ por token y leerla, $$c_r$$; en los precios de Anthropic, la escritura vale 1,25 veces la entrada normal y la lectura 0,1 veces, así que

$$
\frac{c_w}{c_r} = 12{,}5
$$

**Escalonar el arranque.** Si $$k$$ piezas arrancan en el mismo segundo, ninguna encuentra el prefijo en cache y las $$k$$ lo escriben. Si el primer trabajador sale unos segundos antes, los demás lo leen. El ahorro es, como mínimo,

$$
\mathit{ahorro} \ \ge\ (k-1)\, P\, (c_w - c_r)
$$

Con $$k = 3$$, el modelo predice al menos 27 000 tokens menos escritos en cache. Medí 42 000 menos (de 124 000 a 82 000), y el costo bajó de US$0,90 a US$0,71 y 0,72 en dos corridas, en el mismo tiempo. Un 21 %.

**Retomar la conversación del trabajador.** Era la idea que más me gustaba: que un trabajador siga su propia conversación de pieza en pieza, para no pagar el arranque cada vez. Ahorra $$U$$ tokens escritos por pieza retomada, pero cada una de las $$c$$ llamadas de la pieza $$j$$ vuelve a leer la historia acumulada $$H_j$$. Retomar conviene mientras

$$
c\, H_j\, c_r \ <\ U\, (c_w - c_r) \iff H_j \ <\ \frac{U}{c}\Big(\frac{c_w}{c_r} - 1\Big) \approx \frac{10\,000}{5} \cdot 11{,}5 = 23\,000
$$

es decir, mientras la historia acumulada no supere unos 23 000 tokens: más o menos una pieza anterior. La predicción es que retomar da casi igual, con una ganancia chica al principio que se pierde rápido.

Y acá la medición me mintió. La primera vez, la corrida con conversaciones retomadas informó US$1,25 contra 0,71. Parecía la refutación perfecta de mi idea favorita, y casi la escribo así.

No era cierto. El CLI de Claude informa el costo de *toda la conversación*, no el de la invocación: al retomar, el total incluye todas las anteriores. Los tokens que informa, en cambio, son los de esa invocación sola. Baldr sumaba los totales como si fueran parciales, y cada pieza retomada pagaba de nuevo a sus predecesoras. La integración "costaba" 0,33: era 0,198 de la pieza anterior más 0,132 propios. Descontado eso, la corrida cuesta unos US$0,69, prácticamente lo mismo que arrancar de cero. Exactamente lo que predecía la desigualdad.

Lo arreglé en Baldr, que ahora recuerda el último total de cada conversación y cuenta solo la diferencia. Pero la lección es otra: una métrica es una afirmación de alguien, no un hecho. Hay que verificarla como se verifica una pieza.

La analogía con Tungsten, entonces, sale más fina de lo que pensaba. Tungsten funde los operadores de una etapa, pero no arrastra la historia de las filas anteriores. Retomar una conversación sí la arrastra, y lo que se ahorra en el arranque se paga en lectura. Lo que conviene fundir es el arranque, no la memoria.

## Lo que me llevo

Después de mure me quedé con la pregunta de cuánto de una ejecución podemos evitar hacer durable. Este enjambre agrega otra: **cuánto de una coordinación podemos evitar centralizar.**

Bastante más de lo que suponía. Seis reglas:

**Hecho lo decide una verificación, no el que hizo el trabajo.**  
El reporte de un agente es una afirmación. El chequeo sobre el trunk es un hecho.

**La disjunción no se espera, se hace cumplir.**  
Un plan predice qué va a tocar cada uno. Con escrituras disjuntas, integrar conmuta; sin ellas, cada orden es una historia distinta.

**Las escrituras componen; los chequeos no.**  
Que cada parte pase sola no dice nada del todo. Por eso se vuelve a chequear en el trunk y al final.

**Un contrato en prosa es un contrato sin compilador.**  
Si el plan se contradice, el error tiene que volver a quien lo escribió, no quedar compensado en otra parte.

**El entorno del agente es parte del sistema.**  
Su shell, sus variables, sus tiempos. Si no lo definís vos, lo define la máquina.

**Verificá también lo que medís.**  
La idea que más me gustaba pareció salir 76 % más cara. Era el instrumento el que sumaba de más.

Lo que sigue es formalizar de verdad lo que hoy está escrito a mano. El protocolo de reclamo, integración y re-plan es chico: un puñado de variables y cinco o seis acciones. Es exactamente el tamaño para escribirlo en TLA+ y dejar que TLC, el model checker, recorra todos los entrelazados que ningún test va a recorrer, con trabajadores que mueren entre dos pasos y leases que vencen en el peor momento. Quiero ver si S1 aguanta, y si el agujero de la vivacidad es el único.

Y, en otro canal, el problema de dos agentes sobre el mismo archivo. Porque eso ya no es BitTorrent. Es consenso.
