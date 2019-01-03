# Benchmark of reactive queries for PostgreSQL

This test provides a structure for running queries repeatedly while measuring the
application's memory usage as well as measuring response times on an array of
reactive queries using different packages supporting them:
 * [`reactive-postgres`](https://github.com/tozd/node-reactive-postgres)
 * [`pg-live-select`](https://github.com/numtel/pg-live-select)
 * [`pg-live-query`](https://github.com/nothingisdead/pg-live-query)

A reading of [`index.js`](./index.js) (variable `QUERIES`) is recommended to understand the operations
performed. See [`livequery.sql`](./livequery.sql) for a reactive query used.

The following commands can be used to get the application running on your machine:

```bash
$ npm install

# Configure database connection string (CONN_STR)
$ vim index.js

# Start the application with the following command: (Output file is optional)
$ node index.js out.json
```

Run it for a minute or more and press `ctrl+c` to exit and display benchmark graphs.

If an output file is specified, it may be viewed using [`index.html`](./index.html).

## License

MIT
