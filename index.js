var assert = require('assert');
var fs = require('fs');
var Worker = require('worker_threads').Worker;

var babar = require('babar');
var pgp = require('pg-promise')();
var Pool = require('pg').Pool;
var stats = require('stats-lite');

var install = require('./lib/install');

// Connect to this database
var CONN_STR = 'postgres://postgres:pass@127.0.0.1/postgres';

// Instantiate this many reactive queries
var REACTIVE_QUERIES_COUNT = 50;

// Generate this much sample data (see lib/install.js)
var GEN_SETTINGS = [
  REACTIVE_QUERIES_COUNT * 4, // class count
  30, // assignments per class
  20, // students per class
  6  // classes per student
];

// Relative to generated data set
var ASSIGN_COUNT = GEN_SETTINGS[0] * GEN_SETTINGS[1];
var STUDENT_COUNT = Math.ceil(GEN_SETTINGS[0] / GEN_SETTINGS[3]) * GEN_SETTINGS[2];
var SCORES_COUNT = ASSIGN_COUNT * GEN_SETTINGS[2];

if (process.argv.length < 3 || process.argv.length > 4) {
  throw Error("Invalid number of arguments.")
}

var PACKAGE = process.argv[2];

var pool = new Pool({
  connectionString: CONN_STR,
});

var runState = {
  eventCount: 0,
  changesCount: 0,
};

var recordMemoryInterval = null;
var timeouts = [];

var insertsCount = 0;
// Number of inserts which have not yet had insert query return
var unconfirmedInserts = 0;
// A map between inserts (score ID) and timestamp on the client
var insertTimes = new Map();

// Number of updates which have not yet had update query return
var unconfirmedUpdates = 0;
// A map between updates (score ID) and timestamp on the client
var updateTimes = new Map();
var recentUpdateIds = [];

// Description of queries to perform
var QUERIES = [
  // Inserts
  {
    execPerSecond: 100,
    query: 'INSERT INTO scores (id, assignment_id, student_id, score)' +
      ' VALUES ($1, $2, $3, $4)',
    params: function() {
      runState.changesCount++;
      insertsCount++;
      var assignmentId = Math.ceil(Math.random() * ASSIGN_COUNT);
      var classId = ((assignmentId - 1) % GEN_SETTINGS[0]) + 1;
      var scoreId = insertsCount + SCORES_COUNT;
      // Only for these we have reactive queries.
      if (1 <= classId && classId <= REACTIVE_QUERIES_COUNT) {
        insertTimes.set(scoreId, Date.now());
      }
      return [
        scoreId,
        assignmentId,
        Math.ceil(Math.random() * STUDENT_COUNT),
        Math.ceil(Math.random() * 100),
      ];
    }
  },
  // Updates
  {
    execPerSecond: 100,
    query: 'UPDATE scores SET score=$2 WHERE score!=$2 AND id=$1 AND ((((assignment_id - 1) % ' + GEN_SETTINGS[0] + ') + 1) BETWEEN 1 AND ' + REACTIVE_QUERIES_COUNT + ')',
    params: function() {
      runState.changesCount++;
      var scoreId;
      var count = 0;
      do {
        // We do not use the most recent 1000
        scoreId = Math.ceil(Math.random() * (insertsCount + SCORES_COUNT - 1000));
        count += 1;
        if (count === 1000) {
          throw new Error("Looping too long to get a score id.");
        }
      }
      // We are making sure we are not updating the same score twice
      // So that the second update does not mask the first one
      while (recentUpdateIds.indexOf(scoreId) > -1 || updateTimes.has(scoreId));
      updateTimes.set(scoreId, Date.now());
      recentUpdateIds.unshift(scoreId);
      // We remember only the most recent 1000
      recentUpdateIds = recentUpdateIds.slice(0, 1000);
      return [
        scoreId,
        Math.ceil(Math.random() * 100),
      ];
    }
  },
];

var ALL_QUERIES_PER_SECOND = 0;
for (var i = 0; i < QUERIES.length; i++) {
  ALL_QUERIES_PER_SECOND += QUERIES.execPerSecond;
}

var worker = new Worker('./worker.js');
worker.unref();

var startTime;

function recordMemory() {
  global.gc();

  var memUsage = process.memoryUsage();
  var elapsed = (Date.now() - startTime) / 1000;

  worker.postMessage({type: 'heapTotal', value: [ elapsed, memUsage.heapTotal / 1024 / 1024 ]});
  worker.postMessage({type: 'heapUsed', value: [ elapsed, memUsage.heapUsed / 1024 / 1024 ]});

  var now = Date.now();
  var changes = insertTimes.size + updateTimes.size;
  var longChanges = Array.from(insertTimes.values()).concat(Array.from(updateTimes.values())).filter(function(timestamp) {
    return timestamp < now - 5 * 1000;
  }).length;

  process.stdout.write('\r ' + Math.floor(elapsed) + ' seconds elapsed... ('
    + unconfirmedInserts + ' unconfirmed inserts, '
    + unconfirmedUpdates + ' unconfirmed updates, '
    + changes + ' unconfirmed changes, '
    + longChanges + ' unconfirmed changes > 5s)'
  );
}

var interrupted = false;

function interruptHandler() {
  if (interrupted) {
    return;
  }
  interrupted = true;

  // So that double Ctrl+C kills it.
  process.off('SIGINT', interruptHandler);

  clearInterval(recordMemoryInterval);

  while (timeouts.length) {
    clearTimeout(timeouts.shift());
  }

  worker.once('message', (measurements) => {
    worker.terminate();
    worker = null;

    if(process.argv.length === 4) {
      try {
        fs.writeFileSync(process.argv[3], JSON.stringify(measurements, null, 2));
      } catch(err) {
        console.error('Unable to save output!', error);
      }
    }

    console.log('\n Final Runtime Status:', runState);

    var responseTimes = measurements.responseTimes.map(function (responseTime) {
      return responseTime[1];
    });

    console.log(" Response Times Mean: %s", stats.mean(responseTimes));
    console.log(" Response Times Standard Deviation: %s", stats.stdev(responseTimes));

    var histogram = stats.histogram(responseTimes, 50);
    histogram = histogram.values.map(function (value, i) {
      return [histogram.binLimits[0] + i * histogram.binWidth, value];
    });

    console.log(babar(measurements.heapTotal, { caption: "heapTotal (MB)" }));
    console.log(babar(measurements.heapUsed, { caption: "heapUsed (MB)" }));
    console.log(babar(measurements.responseTimes, { caption: "responseTimes (ms)" }));
    console.log(babar(histogram, { caption: "responseTimes histogram" }));

    pool.end();

    if (PACKAGE === 'reactive-postgres-id' || PACKAGE === 'reactive-postgres-changed' || PACKAGE === 'reactive-postgres-full') {
      reactiveQueries.stop().then(process.exit).catch(function(error) {
        console.error("Error stopping manager.", error);
        process.exit(1);
      });
    }
    else if (PACKAGE === 'pg-live-select') {
      reactiveQueries.cleanup(process.exit);
    }
    else if (PACKAGE === 'pg-live-query') {
      process.exit(0);
    }
    else if (PACKAGE === 'pg-query-observer') {
      reactiveQueries.cleanup().then(function () {
        pgp.end();
        process.exit(0);
      }).catch(function(error) {
        console.error("Cleanup error.", error);
        process.exit(1);
      });
    }
  });

  worker.postMessage({type: 'get'});
}

// Save and display output on Ctrl+C
process.on('SIGINT', interruptHandler);

var reactiveQueries;
if (PACKAGE === 'reactive-postgres-id' || PACKAGE === 'reactive-postgres-changed' || PACKAGE === 'reactive-postgres-full') {
  var Manager = require('reactive-postgres').Manager;
  reactiveQueries = new Manager({connectionConfig: {connectionString: CONN_STR}});
  reactiveQueries.start().catch(function(error) {
    console.error("Error starting manager.", error);
    process.exit(1);
  });
}
else if (PACKAGE === 'pg-live-select') {
  var LivePg = require('pg-live-select');
  reactiveQueries = new LivePg(CONN_STR, 'my_channel');
}
else if (PACKAGE === 'pg-live-query-watch' || PACKAGE === 'pg-live-query-query') {
  var LiveQuery = require('pg-live-query');

  // Slight race condition here, but installing data should
  // always take longer than connecting one client.
  pool.connect(function(error, client, done) {
    if (error) throw error;

    reactiveQueries = new LiveQuery(client);
  });
}
else if (PACKAGE === 'pg-query-observer') {
  var PgQueryObserver = require('pg-query-observer').PgQueryObserver;
  var PgTableObserver = require('pg-table-observer').PgTableObserver;

  var db = pgp(CONN_STR);

  reactiveQueries = new PgQueryObserver(db, 'myapp', {
    // To match default in reactive-postgres package.
    trigger_delay: 100,
    keyfield: 'score_id',
  });
  // We override it with our (fixed) version of table observer.
  reactiveQueries.table_observer = new PgTableObserver(db, 'myapp');
}
else {
  throw Error("Unknown package to test.");
}

console.log("Installing data...");

// Install sample dataset and begin test queries
install(pool, GEN_SETTINGS, function(error) {
  if(error) throw error;

  if (global.gc) {
    global.gc();
  }
  else {
    console.error("Cannot run garbage collection. Use --expose-gc when launching node to enable it.");
    process.exit(1);
  }

  console.log('Data installed! Beginning test queries...');

  startTime = Date.now();

  // Record memory usage every second
  recordMemoryInterval = setInterval(recordMemory, 1000);
  recordMemory();

  var reactiveQueryText = fs.readFileSync('reactivequery.sql').toString();
  for(var classId = 1; classId <= REACTIVE_QUERIES_COUNT; classId++) {
    if (PACKAGE === 'reactive-postgres-id' || PACKAGE === 'reactive-postgres-changed' || PACKAGE === 'reactive-postgres-full') {
      var mode;
      if (PACKAGE === 'reactive-postgres-id') {
        mode = 'id';
      }
      else if (PACKAGE === 'reactive-postgres-changed') {
        mode = 'changed';
      }
      else if (PACKAGE === 'reactive-postgres-full') {
        mode = 'full';
      }
      reactiveQueries.query(
        reactiveQueryText.replace('$1',  '' + classId),
        {
          uniqueColumn: 'score_id',
          mode: mode,
        },
      ).then(function(handle) {
        handle.on('insert', function(row) {
          runState.eventCount++;

          // An update about initial scores.
          if (row.score_id <= SCORES_COUNT) {
            return;
          }

          var start = insertTimes.get(row.score_id);
          if(typeof start === 'undefined') {
            console.log('Unexpected insert ' + row.score_id);
          } else {
            var now = Date.now();
            var elapsed = (now - startTime) / 1000;
            worker && worker.postMessage({type: 'responseTimes', value: [ elapsed, now - start ]});
            insertTimes.delete(row.score_id);
          }
        });
        handle.on('update', function(row) {
          runState.eventCount++;

          var start = updateTimes.get(row.score_id);
          if(typeof start === 'undefined') {
            console.log('Unexpected update ' + row.score_id);
          } else {
            var now = Date.now();
            var elapsed = (now - startTime) / 1000;
            worker && worker.postMessage({type: 'responseTimes', value: [ elapsed, now - start ]});
            updateTimes.delete(row.score_id);
          }
        });
        handle.start().catch(function(error) {
          console.error("Error starting a handle.", error);
          process.exit(1);
        });
      }).catch(function(error) {
        console.error("Error creating a handle.", error);
        process.exit(1);
      });
    }
    else if (PACKAGE === 'pg-live-select') {
      (function () {
        var mapIndexToScoreId = new Map();
        reactiveQueries.select(reactiveQueryText, [ classId ]).on('update', function(diff, data) {
          runState.eventCount++;

          var updated = new Set();

          if (diff.removed) {
            REMOVED: for (var i = 0; i < diff.removed.length; i++) {
              var scoreId = mapIndexToScoreId.get(diff.removed[i]._index);
              mapIndexToScoreId.delete(diff.removed[i]._index);
              if(typeof scoreId === 'undefined') {
                console.log('Unexpected removal ' + diff.removed[i]._index);
              } else {
                // Is update?
                var added = diff.added || [];
                for (var j = 0; j < added.length; j++) {
                  if (added[j]._index === diff.removed[i]._index) {
                    updated.add(scoreId);
                    // Yes it is.
                    var start = updateTimes.get(scoreId);
                    if(typeof start === 'undefined') {
                      console.log('Unexpected update ' + scoreId);
                    } else {
                      var now = Date.now();
                      var elapsed = (now - startTime) / 1000;
                      worker && worker.postMessage({type: 'responseTimes', value: [ elapsed, now - start ]});
                      updateTimes.delete(scoreId);
                    }

                    continue REMOVED;
                  }
                }

                // TODO: Process removed.
              }
            }
          }

          if (diff.added) {
            for (var i = 0; i < diff.added.length; i++) {
              mapIndexToScoreId.set(diff.added[i]._index, diff.added[i].score_id);
              // An update about initial scores.
              if (diff.added[i].score_id <= SCORES_COUNT) {
                continue;
              }
              if (updated.has(diff.added[i].score_id)) {
                continue;
              }
              var start = insertTimes.get(diff.added[i].score_id);
              if(typeof start === 'undefined') {
                console.log('Unexpected insert ' + diff.added[i].score_id);
              } else {
                var now = Date.now();
                var elapsed = (now - startTime) / 1000;
                worker && worker.postMessage({type: 'responseTimes', value: [ elapsed, now - start ]});
                insertTimes.delete(diff.added[i].score_id);
              }
            }
          }
        });
      })();
    }
    else if (PACKAGE === 'pg-live-query-watch' || PACKAGE === 'pg-live-query-query') {
      var handle;
      if (PACKAGE === 'pg-live-query-watch') {
        handle = reactiveQueries.watch(reactiveQueryText.replace('$1',  '' + classId));
      }
      else if (PACKAGE === 'pg-live-query-query') {
        handle = reactiveQueries.query(reactiveQueryText.replace('$1',  '' + classId));
      }

      handle.on('insert', (id, row, cols) => {
        runState.eventCount++;

        assert(cols[3] === 'score_id');
        var score_id = row[3];

        // An update about initial scores.
        if (score_id <= SCORES_COUNT) {
          return;
        }

        var start = insertTimes.get(score_id);
        if(typeof start === 'undefined') {
          console.log('Unexpected insert ' + score_id);
        } else {
          var now = Date.now();
          var elapsed = (now - startTime) / 1000;
          worker && worker.postMessage({type: 'responseTimes', value: [ elapsed, now - start ]});
          insertTimes.delete(score_id);
        }
      });

      handle.on('update', (id, row, cols) => {
        runState.eventCount++;

        assert(cols[3] === 'score_id');
        var scoreId = row[3];

        var start = updateTimes.get(scoreId);
        if(typeof start === 'undefined') {
          console.log('Unexpected update ' + scoreId);
        } else {
          var now = Date.now();
          var elapsed = (now - startTime) / 1000;
          worker && worker.postMessage({type: 'responseTimes', value: [ elapsed, now - start ]});
          updateTimes.delete(scoreId);
        }
      });
    }
    else if (PACKAGE === 'pg-query-observer') {
      reactiveQueries.notify(reactiveQueryText, [ classId ], function (change) {return true}, function (diff) {
        runState.eventCount++;

        for (var i = 0; i < diff.added.length; i++) {
          // An update about initial scores.
          if (diff.added[i].score_id <= SCORES_COUNT) {
            continue;
          }
          var start = insertTimes.get(diff.added[i].score_id);
          if(typeof start === 'undefined') {
            console.log('Unexpected insert ' + diff.added[i].score_id);
          } else {
            var now = Date.now();
            var elapsed = (now - startTime) / 1000;
            worker && worker.postMessage({type: 'responseTimes', value: [ elapsed, now - start ]});
            insertTimes.delete(diff.added[i].score_id);
          }
        }
      }).catch(function (error) {
        console.error("Error creating a handle.", error);
        process.exit(1);
      });

      // TODO: Process updates and removals once package works.
    }
  }

  QUERIES.forEach(function(description, i) {
    timeouts.push(setInterval(function() {
      pool.connect(function(error, client, done) {
        if(error) throw error;

        var params = description.params();
        var insertedForReactiveQuery = insertTimes.has(params[0]);
        // Second query is update.
        var updated = i === 1;
        if (insertedForReactiveQuery) {
          unconfirmedInserts += 1;
        }
        else if (updated) {
          assert(updateTimes.has(params[0]));
          unconfirmedUpdates += 1;
        }
        client.query(description.query, params,
          function(error, result) {
            done();
            // Update query did not match anything, revert
            if (result.command === 'UPDATE' && result.rowCount === 0) {
              assert(updateTimes.has(params[0]));
              updateTimes.delete(params[0]);
            }
            if (insertedForReactiveQuery) {
              unconfirmedInserts -= 1;
            }
            else if (updated) {
              unconfirmedUpdates -= 1;
            }
            if(error) throw error;
          }
        );
      });
    }, 1000 / description.execPerSecond));
  });
});

