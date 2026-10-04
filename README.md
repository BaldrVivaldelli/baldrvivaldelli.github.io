# Yapa

Lo que viene de más con cada proyecto: notas en markdown en [notas/](notas/), publicadas en https://baldrvivaldelli.github.io/ con cada push a `main`.

## Escribir una nota

Un archivo nuevo en `notas/`, con la fecha de publicación adelante:

```
notas/2026-10-04-el-estado-que-no-se-guarda.md
```

La fecha del nombre es la que muestra el sitio, y el resto es la dirección: esa nota queda en `/el-estado-que-no-se-guarda/`. La primera línea es el título:

```markdown
# El estado que no se guarda

*Si el primer párrafo va entero en itálica, el sitio lo muestra como bajada.*

Y después, el texto.
```

No hace falta nada más. Se puede escribir desde la web de GitHub, con *Add file* y *Create new file*: al commitear en `main`, el sitio se actualiza solo en un par de minutos.

- **Fórmulas**: en bloque, entre `$$`. GitHub también las muestra. Un `$` suelto queda como texto, para que un precio no se lea como fórmula.
- **Imágenes**: al lado de la nota, con ruta relativa, como `![diagrama](imagenes/diagrama.png)`.
- **Enlaces a otra nota**: al archivo, como `[otra nota](2026-10-05-otra.md)`. Funcionan igual en GitHub y en el sitio.
- **Borradores**: un archivo que empieza con `_` no se publica.

Si alguna vez hace falta pisar algo, la nota acepta front matter, y todo es opcional:

```yaml
---
title: Un título distinto para el sitio
description: El texto del listado y de los buscadores. Por omisión, el primer párrafo.
date: 2026-10-05
draft: true
---
```

## Verlo en local

Con Node 22.12 o más nuevo:

```sh
npm install
npm run dev
```

## Cómo se publica

[publicar.yml](.github/workflows/publicar.yml) compila el sitio con [Astro](https://astro.build) y lo sube a GitHub Pages en cada push a `main`. La dirección sale del nombre del repositorio, así que renombrarlo no pide cambiar nada: un repo llamado `usuario.github.io` se publica en la raíz, y cualquier otro, en `usuario.github.io/nombre/`.

El nombre y la descripción del sitio están en [src/site.ts](src/site.ts).
