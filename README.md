# Benchmark of reactive queries for PostgreSQL

This test provides a structure for running data modification queries repeatedly while
at the same time measuring the performance of reactive queries using different packages supporting them:
 * [`reactive-postgres`](https://github.com/tozd/node-reactive-postgres)
 * [`pg-live-select`](https://github.com/numtel/pg-live-select)
 * [`pg-live-query`](https://github.com/nothingisdead/pg-live-query)
 * [`pg-query-observer`](https://github.com/Richie765/pg-query-observer)

A reading of [`index.js`](./index.js) (variable `QUERIES`) is recommended to understand the operations
performed. See [`livequery.sql`](reactivequery.sql) for a reactive query used. By default,
the benchmark opens 50 parallel reactive queries, each reactive query having a different
`assignments.class_id` condition, and inserts 100 rows into `scores` table per second.

The following commands can be used to get the application running on your machine:

```bash
$ npm install

# Configure database connection string (CONN_STR)
$ vim index.js

# Start the application with the following command: (Output file is optional)
$ node --experimental-worker --expose-gc index.js reactive-postgres-id out.json
```

The first argument tell which package/configuration to use. Available options are:
* `reactive-postgres-id`: in `id` mode
* `reactive-postgres-changed`: in `changed` mode
* `reactive-postgres-full`: in `full` mode
* `pg-live-select`
* `pg-live-query-watch`: using `watch` (unstable initialization, has to be tried multiple times)
* `pg-live-query-query`: using `query` (unstable initialization, has to be tried multiple times)
* `pg-query-observer` (it does not work with multiple parallel queries)

Run it for a minute or more and press `ctrl+c` to exit and display benchmark graphs.

The following measurements are done:
* [Used node heap](https://nodejs.org/api/process.html#process_process_memoryusage) every second.
* [Total node heap](https://nodejs.org/api/process.html#process_process_memoryusage) every second.
* Time between a data modification query being issued to the database, and when a reactive
  query emitted a corresponding event.

## Results viewer

If an output file is specified, it may be viewed using [`viewer.html`](./viewer.html).
To use this test result viewer, first start a web server in the root directory of the
repository:

```bash
$ python -m SimpleHTTPServer
```

Then load the output JSON file by specifying it in the query string:
[`http://localhost:8000/viewer.html?out.json`](http://localhost:8000/viewer.html?out.json)

## Results

Evaluated using node v11.6.0 on Linux and this [PostgreSQL 11.1 Docker image](https://github.com/mitar/docker-postgres).
The following command was used for each of the available packages/configurations:

```bash
$ timeout --foreground --signal=INT --kill-after=5 300 node --experimental-worker --expose-gc index.js package <package>.json
```

Results are available through web viewer:

* [`reactive-postgres-id`](https://mitar.github.io/node-pg-reactivity-benchmark/viewer.html?results/reactive-postgres-id.json)
* [`reactive-postgres-changed`](https://mitar.github.io/node-pg-reactivity-benchmark/viewer.html?results/reactive-postgres-changed.json)
* [`reactive-postgres-full`](https://mitar.github.io/node-pg-reactivity-benchmark/viewer.html?results/reactive-postgres-full.json)
* [`pg-live-select`](https://mitar.github.io/node-pg-reactivity-benchmark/viewer.html?results/pg-live-select.json)
* [`pg-live-query-watch`](https://mitar.github.io/node-pg-reactivity-benchmark/viewer.html?results/pg-live-query-watch.json)
* [`pg-live-query-query`](https://mitar.github.io/node-pg-reactivity-benchmark/viewer.html?results/pg-live-query-query.json)
* pg-query-observer: does not work with multiple parallel queries
