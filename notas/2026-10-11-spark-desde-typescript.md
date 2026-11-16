# Spark desde TypeScript

*Escribí un cliente de Spark Connect en TypeScript. La tesis que lo ordena: el plan de ejecución es un valor, y los tipos no tienen permitido mentir.*

[ts-spark-connector](https://github.com/BaldrVivaldelli/ts-spark-connector) es un cliente de [Spark Connect](https://spark.apache.org/docs/latest/spark-connect-overview.html) escrito en TypeScript. Construye planes lógicos de Spark del lado del cliente y los ejecuta contra un servidor por gRPC. Está en npm:

```bash
npm i ts-spark-connector
```

Spark Connect cambió algo fundamental en Spark 4: el cliente ya no necesita una JVM. El protocolo es gRPC más protobuf, y los resultados viajan como Arrow. Eso abre la puerta a clientes en cualquier lenguaje. PySpark tiene el suyo. Este es el de TypeScript.

## El plan es un valor

Cuando escribís esto:

```ts
const df = purchases
  .select("user_id", "product", "amount")
  .filter(col("amount").gt(100))
  .orderBy(col("user_id").descNullsLast());
```

no pasó nada todavía. No hay conexión, no hay datos, no hay Spark. `df` es la *descripción* de un cómputo: un programa sobre un álgebra de DataFrames, sin comprometerse con ninguna representación.

Ejecutarlo es interpretarlo. Y ejecutar es solo **uno** de los intérpretes:

```ts
await df.collect();              // intérprete 1: protobuf → gRPC → Spark
console.log(df.toClientASTMermaid());   // intérprete 2: el plan como diagrama
console.log(df.toProtoJSON());          // intérprete 3: lo que viaja por el cable
```

El mismo valor se puede ejecutar, dibujar o auditar. Cuando un pipeline hace algo raro en producción, poder imprimir el plan exacto que se mandó — sin ejecutarlo — vale más que cualquier log.

La consecuencia arquitectónica es que agregar una operación nueva obliga a decidir qué hace en *cada* intérprete: el compilador de TypeScript no deja que la inspección de planes se quede atrás de la ejecución. No es disciplina: es el type checker trabajando de guardia.

## Los tipos no tienen permitido mentir

El problema clásico de tipar un DataFrame es el drift: el tipo que declaraste en el código y el schema que el servidor aplica se separan en silencio, y te enterás a las tres de la mañana.

Acá hay una sola declaración, y de ella derivan las dos cosas:

```ts
const Events = schema({
  id: "long",
  occurredAt: "timestamp",
  amount: decimalType(18, 4),
  tags: arrayType("string"),
});

const events = session.read.readWith(Events, "parquet", "/data/events");
const rows = await events.select("id", "amount").collect();
// rows: Array<{ id: bigint; amount: string }>
```

`Events` genera el tipo de TypeScript **y** el DDL que viaja a Spark, así que el servidor aplica exactamente el schema que el código promete. No hay dos fuentes de verdad que puedan separarse.

Y donde el metadato no alcanza, se verifica contra los datos. Spark marca toda columna de un archivo como nullable, diga lo que diga tu schema; en vez de confiar, el cliente chequea: si declaraste una columna no-nula y aparece un null, `collect()` falla nombrando la columna. La promesa se verifica, no se asume.

Dos decisiones chiquitas que me importan especialmente:

- Un `BIGINT` de Spark es un `bigint` de JavaScript. Siempre. Un `number` de JavaScript pierde precisión arriba de 2⁵³, y un id de 64 bits corrupto en silencio es el peor bug posible: no explota, da *otro resultado*.
- Un decimal es un string exacto. IEEE-754 no opina sobre tu plata.

## ¿Y PySpark?

PySpark es el cliente de referencia y no compite en madurez. Pero tipa en runtime: el schema vive en el servidor y tu editor no sabe nada. La experiencia acá es otra: autocompletado sobre las columnas, un `filter` sobre una columna renombrada es error de compilación, y el refactor de un pipeline largo es seguro porque el compilador lo recorre entero.

Para un equipo que ya vive en TypeScript — un backend en Node que necesita consultar el lake, un BFF que arma features — la alternativa real no era PySpark: era un microservicio Python más en el medio, o un puente JSON que pierde los longs.

## Producción, no demo

Las partes aburridas son la mitad del proyecto, así que están: TLS con keystores PKCS#12, credenciales rotativas por RPC (OIDC, STS, lo que sea — un provider es una función que devuelve headers), retries con clasificación de errores, ejecución reatacheable que sobrevive cortes del stream, telemetría estructurada que redacta secretos antes de llegar al sink.

Y una regla que me impuse: **no afirmo compatibilidad que no tenga matriz verde**. El repo trae un servidor Spark dockerizado parametrizado por versión, y el CI corre la suite E2E completa contra Spark 4.0.0, 4.0.4, 4.1.3 y 4.2.0, con TLS, en cada push. Lo que el README dice que funciona, lo probó una máquina esta semana.

Sobre el proceso: buena parte del código lo escribió IA, igual que en [mure](2026-10-04-el-estado-que-no-se-guarda.md). La dirección — el álgebra como centro, los tipos que no mienten, la matriz como criterio de verdad — es el trabajo. Lo demás es tipeo.

## Lo que sigue

Están en revisión tres piezas: `session.catalog` (metadata del catálogo como DataFrames), `createDataFrame` (filas locales → Spark vía Arrow, con roundtrip sin pérdida), y Delta Lake + Iceberg verificados E2E contra el servidor del repo.

Si trabajás con Spark desde Node y lo probás, contame qué falta: el issue tracker está abierto.
