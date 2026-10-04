# El estado que no se guarda

*Construí un cliente BitTorrent para entender ejecución durable. Terminé aprendiendo que, muchas veces, la mejor forma de persistir estado es no persistirlo.*

mure es un cliente BitTorrent escrito desde cero en Go.

Nació como un laboratorio para aprender dos cosas que me interesaban: cómo funciona realmente BitTorrent y qué significa construir ejecución durable.

Claramente usé IA para escribir buena parte del código. No voy a fingir que tipeé decenas de miles de líneas a mano; eso sería bastante siglo XX. Pero la dirección, las decisiones de arquitectura, el orden en que se construyó, las propiedades que quería preservar y la matemática detrás fueron mías. Los BEP hicieron el resto: un océano de conocimiento acumulado durante décadas.

La pregunta que terminó ordenando todo el proyecto fue mucho más simple de lo que esperaba:

**¿Qué estado realmente necesito guardar?**

La respuesta fue:

**mucho menos del que parece.**

El journal de mure no sabe qué piezas descargó un torrent. No tiene una columna de progreso ni una lista durable de piezas verificadas.

El disco es el log.

Cada pieza de BitTorrent tiene un hash esperado. Eso significa que, después de un crash, no necesito recordar cuáles piezas tenía: puedo preguntárselo al disco.

$$
\mathit{have}_i \iff \mathrm{SHA1}(\mathit{disk}_i) = \mathit{hash}_i
$$

Esa pequeña propiedad se convirtió en la tesis de todo el proyecto.

## El journal guarda decisiones, no progreso

Un cliente BitTorrent tiene que recordar algunas cosas que nadie más puede reconstruir.

Qué torrent eligió una persona.

Dónde decidió guardarlo.

Qué obligación de seeding ya se cumplió.

Pero casi todo lo demás puede volver a descubrirse.

Las piezas se reconstruyen leyendo el disco.

Los peers se vuelven a encontrar preguntándoles a los trackers, a la DHT o al propio swarm.

Las conexiones desaparecen.

Los requests en vuelo desaparecen.

La tabla de routing de la DHT puede reconstruirse.

El estado del scheduler puede reconstruirse.

El swarm es durable para **los datos**, no para **la ejecución**.

Que la red distribuida conserve las piezas no hace durable a mi proceso. Mi proceso puede morir en cualquier momento.

Lo que la distribución sí me regala es algo muchísimo más interesante:

**re-derivabilidad.**

Y si algo puede volver a derivarse de una fuente más autoritativa, persistirlo introduce una segunda verdad.

En mure, el estado durable empezó siendo esencialmente:

$$
\mathit{DurableState} = \mathit{Journal} + \mathit{Disk}
$$

El journal recuerda las decisiones que el mundo no puede devolverme.

El disco demuestra qué bytes realmente existen.

Todo lo demás es temporal.

## Dos verdades son peores que una

Supongamos que guardo en SQLite:

```text
piece_512 = verified
```

Pero después el proceso muere en un mal momento, el filesystem pierde páginas todavía no sincronizadas o alguien modifica el archivo.

Ahora tengo dos afirmaciones:

```text
journal: piece_512 = verified
disk:    piece_512 = corrupt
```

¿Cuál es la verdad?

En mure decidí que la respuesta fuera siempre la misma:

**el disco.**

El journal no guarda las piezas verificadas.

Cuando un torrent incompleto arranca, `Scan` lee sus piezas y vuelve a calcular sus hashes.

El costo existe: lo estimé en unos dos segundos por GB de SHA-1.

Pero eso cambia la naturaleza del problema.

Mientras el torrent no está completo, el `fsync` de cada pieza deja de ser necesario para preservar la **corrección**.

Pasa a ser una decisión de **costo**.

Si el proceso o la máquina se caen antes de que ciertos datos lleguen al disco, simplemente tendré que descargar esos bytes otra vez.

No perdí consistencia.

Perdí tiempo.

Esa diferencia resultó central.

## Esto no es lo que hace normalmente la ejecución durable

Los sistemas de ejecución durable suelen resolver un problema más general.

[Temporal](https://docs.temporal.io/workflow-execution) conserva la historia de un workflow y vuelve a ejecutar código contra ella.

[Restate](https://docs.restate.dev/concepts/durable_execution) registra operaciones y resultados para no repetir efectos que ya ocurrieron.

Eso tiene sentido porque muchos efectos del mundo real no son reproducibles.

Enviar un pago dos veces no es lo mismo que volver a verificar un bloque de disco.

Mandar un email dos veces tiene consecuencias.

Hashear una pieza otra vez, no.

BitTorrent tiene una característica particularmente conveniente: los datos son **autoverificables**.

No necesito confiar en el proceso anterior.

Ni siquiera necesito confiar en quien me entregó los bytes.

El hash me permite preguntar:

> ¿estos son los bytes que deberían estar acá?

Por eso mure terminó pareciéndose menos a un workflow engine y más a un controlador que reconcilia, como los de [Kubernetes](https://kubernetes.io/docs/concepts/architecture/controller/).

Hay una intención durable.

Hay un mundo observable.

Y el trabajo consiste en llevar el segundo hacia el primero.

## Crash-only: recuperar es arrancar

La consecuencia natural fue intentar que mure no tuviera un camino especial de recuperación.

Recuperarse de un crash significa arrancar.

Nada más.

Abrir el journal.

Mirar el disco.

Volver a descubrir peers.

Continuar.

La idea viene de [*Crash-Only Software*](https://www.usenix.org/conference/hotos-ix/crash-only-software), de Candea y Fox: intentar que shutdown y recovery dejen de ser caminos excepcionales del sistema.

En mure esto llegó a una regla bastante concreta:

**`Resume` no debería saber hacer nada que un arranque normal no sepa hacer.**

La primera prueba seria fue extremadamente poco sofisticada.

qBittorrent 5.2.3 estaba seedeando un archivo de 64 MB dividido en 1024 piezas.

mure llegó aproximadamente al 36 %.

Entonces:

```bash
kill -9
```

Al arrancar otra vez, mure escaneó el disco.

Encontró exactamente **373 de las 1024 piezas**.

Volvió a pedir el resto.

El SHA-256 final fue idéntico al del original.

Después hice algo más interesante.

Corrompí manualmente un byte de la pieza 512.

El siguiente scan encontró:

```text
1023/1024
```

Y descargó únicamente la pieza dañada.

No escribí un mecanismo de reparación.

La recuperación y la reparación eran el mismo algoritmo.

Eso me gustó mucho.

## El magnet llevó la idea al extremo

Un magnet puede empezar prácticamente con veinte bytes de identidad.

No tiene las piezas.

No tiene la metadata.

Puede no tener trackers.

Todo lo demás tiene que aparecer desde el swarm.

mure primero busca peers.

Después usa [BEP 9](https://www.bittorrent.org/beps/bep_0009.html) para pedir la metadata.

Pero esos bytes no se aceptan porque un peer diga que son correctos.

Se verifica:

$$
\mathrm{SHA1}(\mathit{metadata}) = \mathit{infoHash}
$$

Recién entonces la metadata entra al journal.

A partir de ahí empieza la descarga normal.

Lo probé con un magnet de Debian contra la red pública, sin nada más que el info-hash.

La segunda ejecución de ese mismo magnet fue probablemente la demostración más limpia de la tesis.

La metadata ya estaba en el journal.

Las piezas estaban en el disco.

mure leyó la metadata del journal, re-derivó del disco las 3024 piezas y terminó.

**Cero paquetes a la red.**

No había nada más que aprender.

## Pero la tesis tuvo que ceder

Acá está la parte que me parece más interesante.

Una regla útil no es una regla que nunca cambia.

Es una regla cuya frontera entendés.

Con el tiempo aparecieron cosas que **sí** tenían que persistirse.

### La metadata

En un magnet, la metadata viene de otro peer, no de una decisión humana.

Sin embargo, reconstruirla cada vez sería caro.

Puede guardarse porque además tiene una propiedad importante: no puede mentir silenciosamente.

Antes de aceptarla verificamos que produzca el info-hash esperado.

Es un caché verificable.

### `complete`

Al principio la regla era volver a derivar todo desde el disco.

Pero hashear una biblioteca completa cada vez que arranca un proceso puede costar minutos.

Así, `complete` dejó de ser solo una fase y pasó a creerse: un torrent marcado como completo no se vuelve a hashear al arrancar.

Eso es, en esencia, un fast-resume de un solo bit.

Pero hay una condición:

**lo que se cree tiene que volver a verificarse antes de que importe.**

Cuando ese torrent empieza un turno de seeding, mure vuelve a mirar el disco.

Si encuentra todos los archivos pero alguna pieza dañada, la vuelve a bajar por el mismo camino que una descarga normal.

El journal no retrocede.

Sigue diciendo `complete`.

El disco era el que estaba roto, y el disco se repara.

### El seeding

Después apareció una clase distinta de información.

Supongamos que mi política dice:

```text
seed ratio = 1.0
```

¿Cuánto devolví al swarm?

El disco no lo sabe.

La red tampoco.

Si después de cada restart vuelvo a empezar desde cero, el comportamiento depende de cuántas veces se reinició el proceso.

Eso rompe la idea de crash-only.

Pero tampoco quería persistir contadores continuamente.

La solución fue registrar solamente el hecho irreversible:

```text
seeded
```

La deuda se pagó.

Si el proceso muere antes de llegar ahí, puede terminar entregando algo de más.

Nunca de menos.

### Los trackers de un magnet

Un magnet puede nombrar sus trackers, pero el metainfo que llega después no los trae, y un reinicio los perdía.

No existe otra autoridad que pueda reconstruir esa decisión.

Entonces esos trackers también tuvieron que entrar al journal.

Los peers del magnet, en cambio, siguen sin entrar.

Un peer es perecedero.

Un tracker elegido forma parte de la fuente durable del torrent.

### Las migraciones

Y al final apareció la ironía definitiva:

**el propio journal también se puede caer.**

En una versión, crear la tabla y registrar la versión del esquema eran dos operaciones separadas.

Un crash entre ambas podía dejar un journal existente que la siguiente ejecución no podía abrir.

Desde entonces, cada paso de migración se escribe en la misma transacción que su versión.

El mecanismo encargado de recuperar al resto del sistema también necesita ser recuperable.

## Entonces, ¿qué significa “estado durable mínimo”?

Al principio mi definición era:

> guardar únicamente lo que no puede reconstruirse.

Hoy la escribiría de manera un poco diferente:

> **guardar lo que no puede reconstruirse, más aquello que sería demasiado costoso reconstruir continuamente.**

La diferencia importa.

Minimalismo no significa tener pocas columnas.

Significa que cada columna tenga una razón.

Que puedas contestar:

> ¿Qué propiedad perdería si borro esto?

Si la respuesta es “ninguna, porque lo puedo volver a descubrir”, probablemente estás persistiendo un caché.

Y si ese caché empieza a comportarse como autoridad, acabás de crear dos verdades.

## Las propiedades se escribieron en el momento

Mientras construía mure fui anotando las propiedades que cada decisión debía preservar.

No después.

En el momento.

Algunas son invariantes.

Por ejemplo:

**I1 — integridad**

$$
\mathit{have}_i \Rightarrow \mathrm{SHA1}(\mathit{disk}_i) = \mathit{hash}_i
$$

**I3 — las fases solo avanzan**

```text
added → metadata → downloading → complete → seeded
```

**I4 — durabilidad mínima**

El estado durable es el journal más aquello que está realmente en disco.

Otras son propiedades de liveness.

Por ejemplo:

si siempre existe un peer honesto conectado, que no nos chokea y posee alguna pieza faltante, y el scheduler es justo, la descarga eventualmente debería terminar.

Hoy la mayoría de esas propiedades están sostenidas por tests y experimentos, no por una demostración formal.

Eso es deliberado.

Tengo un modelo más formal detrás y la intención es llevar una parte pequeña —journal, scan, transiciones y crashes— a TLA+.

Pero hay una regla más mundana que resultó extraordinariamente útil:

**un test de regresión tiene que fallar cuando revierto el arreglo.**

Parece obvio.

No lo es.

Más de una vez revertí el fix y el test siguió verde.

Eso significa que el test no demostraba lo que yo pensaba que demostraba.

El test estaba roto.

## La red real tiene derecho a contradecirte

Otra regla del proyecto fue intentar validar cada capa contra una contraparte real.

No quería que mure hablara únicamente consigo mismo.

qBittorrent descargó piezas servidas por mure.

mure descargó de qBittorrent.

uTP se probó contra otra implementación.

Los magnets se probaron contra la DHT pública.

PEX aprendió peers reales.

UPnP y NAT-PMP se probaron contra miniupnpd.

Y varias veces la red real encontró errores que ninguna prueba local había encontrado.

La primera descarga real que intentaba TCP y uTP en paralelo terminó en un panic.

Ningún test tocaba ese camino de error, porque en los tests el uTP siempre conectaba.

Uno de mis favoritos, en cambio, apareció antes de llegar a la red: en uTP, cuando el primer stream pasó por un relay de pruebas que perdía paquetes.

Un paquete perdido detrás de una ventana llena podía congelar el flujo.

El estimador de RTT empezaba a interpretar el tiempo que un paquete pasaba esperando detrás del hueco como latencia real.

Eso inflaba el RTO.

El mecanismo de recuperación de pérdidas estaba contaminando la estimación de latencia.

Agregar selective acknowledgements arregló la raíz del problema.

La lección fue más general que uTP:

**en un transporte confiable, la señal de pérdida y la estimación de RTT no son independientes.**

Un mecanismo malo puede envenenar al otro.

Ese tipo de conclusión difícilmente aparece implementando solamente el happy path de un protocolo.

## IA, pero con método

mure también fue un experimento sobre cómo quiero trabajar con agentes.

Yo elegía qué construir.

En qué orden.

Qué propiedad tenía que mantenerse.

Qué alternativa no quería aceptar.

Claude escribía buena parte del código y ayudaba a mantener la bitácora.

Después otros agentes intentaban romperlo.

El método quedó en cuatro piezas:

1. **Bitácora de decisiones.** Contexto, decisión, alternativas descartadas, propiedad y evidencia. Una decisión revertida no se edita: se agrega otra entrada.

2. **Contrapartes reales.** Los protocolos se prueban contra implementaciones que no controlamos.

3. **Mutación manual de los fixes.** Se revierte el arreglo y el test debe romperse.

4. **Revisión adversaria.** Otro agente entra con la tarea explícita de encontrar una forma de violar las propiedades del sistema.

Las revisiones encontraron bugs reales.

PEX permitía que un peer hiciera crecer el pool sin límite.

uTP anunciaba una ventana de recepción que en realidad no respetaba.

El journal tenía huecos que contradecían la propia tesis del proyecto.

Incluso este artículo encontró un bug.

Al contrastar la explicación de `complete` contra el código apareció un camino que escribía `complete` en el journal sin sincronizar antes los datos.

Escribir sobre el sistema terminó siendo otra forma de testearlo.

## Lo que me llevo

La ejecución durable suele empezar con una pregunta:

**¿qué tengo que guardar?**

Después de mure, prefiero empezar con otra:

**¿qué puedo volver a derivar?**

Y después:

**¿cuál es la autoridad que me permite derivarlo?**

Si la respuesta existe, quizá no necesito otra copia durable.

De todo el proyecto me quedo con seis reglas.

**La recuperación debería ser el arranque normal.**  
Un camino que corre todos los días se prueba constantemente. Un camino que existe exclusivamente para recuperarse de un desastre casi nunca.

**Mínimo significa exacto, no pequeño.**  
Guardá decisiones, obligaciones y hechos que nadie más puede reconstruir, y lo que cuesta demasiado reconstruir seguido. No persistas estado solo porque podés.

**Un caché nunca debería convertirse accidentalmente en autoridad.**  
Si el disco puede contradecir una tabla, necesitás decidir cuál manda.

**Lo que se cree tiene que poder comprobarse.**  
`complete` funciona porque, antes de servir esos bytes, volvemos a mirarlos.

**Las escrituras tienen un orden semántico.**  
Datos antes que `complete`. Metadata antes que avanzar de fase. Migración y versión juntas.

**Las propiedades deberían escribirse junto con las decisiones.**  
Si no sabés qué invariante estás preservando, después tampoco vas a saber si una optimización lo rompió.

El siguiente paso para mure es formalizar una parte pequeña del sistema.

Journal.

Scan.

Transiciones.

Crashes entre cada paso.

Quiero que TLC, el model checker de TLA+, intente encontrar el estado que ni los tests, ni la red pública, ni las revisiones adversarias imaginaron.

Porque después de todo este proyecto, la idea que más me interesa ya no es cómo hacer durable una ejecución.

Es casi la contraria:

**cuánto de una ejecución podemos evitar hacer durable.**
