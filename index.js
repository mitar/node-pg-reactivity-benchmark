var fs = require('fs');
var babar = require('babar');
var Pool = require('pg').Pool;

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

var timeouts = [];

var insertTimes = {};

// Description of queries to perform
var QUERIES = [
  {
    execPerSecond: 100,
    query: 'INSERT INTO scores (id, assignment_id, student_id, score)' +
      ' VALUES ($1, $2, $3, $4)',
    params: function() {
      runState.changesCount++;
      var assignmentId = Math.ceil(Math.random() * ASSIGN_COUNT);
      var classId = ((assignmentId - 1) % GEN_SETTINGS[0]) + 1;
      // Only for these we have reactive queries.
      if (1 <= classId && classId <= REACTIVE_QUERIES_COUNT) {
        insertTimes[runState.changesCount + SCORES_COUNT] = Date.now();
      }
      return [
        runState.changesCount + SCORES_COUNT,
        assignmentId,
        Math.ceil(Math.random() * STUDENT_COUNT),
        Math.ceil(Math.random() * 100)
      ];
    }
  }
];

var ALL_QUERIES_PER_SECOND = 0;
for (var i = 0; i < QUERIES.length; i++) {
  ALL_QUERIES_PER_SECOND += QUERIES.execPerSecond;
}

var startTime;
var measurements = { heapTotal: [], heapUsed: [], responseTimes: [] };

function recordMemory() {
  var memUsage = process.memoryUsage();
  var elapsed = (Date.now() - startTime) / 1000;

  measurements.heapTotal.push([ elapsed, memUsage.heapTotal / 1024 / 1024 ]);
  measurements.heapUsed.push([ elapsed, memUsage.heapUsed / 1024 / 1024 ]);

  var now = Date.now();
  var unconfirmed = Object.values(insertTimes).length;
  var longUnconfirmed = Object.values(insertTimes).filter(function(timestamp) {
    return timestamp < now - 5 * 1000;
  }).length;

  process.stdout.write('\r ' + Math.floor(elapsed) + ' seconds elapsed... (' + unconfirmed + ' unconfirmed changes, ' + longUnconfirmed + ' unconfirmed > 5s)');
}

var interrupted = false;

// Save and display output on Ctrl+C
process.on('SIGINT', function() {
  if (interrupted) {
    return;
  }
  interrupted = true;

  while (timeouts.length) {
    clearTimeout(timeouts.shift());
  }

  if(process.argv.length === 4) {
    try {
      fs.writeFileSync(process.argv[3], JSON.stringify(measurements, null, 2));
    } catch(err) {
      console.error('Unable to save output!', error);
    }
  }

  console.log('\n Final Runtime Status:', runState);

  console.log(babar(measurements.heapTotal, { caption: "heapTotal (MB)" }));
  console.log(babar(measurements.heapUsed, { caption: "heapUsed (MB)" }));
  console.log(babar(measurements.responseTimes, { caption: "responseTimes (ms)" }));

  pool.end();

  if (PACKAGE === 'reactive-postgres-id' || PACKAGE === 'reactive-postgres-changed' || PACKAGE === 'reactive-postgres-full') {
    reactiveQueries.stop().then(process.exit);
  }
  else if (PACKAGE === 'pg-live-select') {
    reactiveQueries.cleanup(process.exit);
  }
  else if (PACKAGE === 'pg-live-query') {

  }
});

var reactiveQueries;
if (PACKAGE === 'reactive-postgres-id' || PACKAGE === 'reactive-postgres-changed' || PACKAGE === 'reactive-postgres-full') {
  var Manager = require('reactive-postgres').Manager;
  reactiveQueries = new Manager({connectionConfig: {connectionString: CONN_STR}});
  reactiveQueries.start();
}
else if (PACKAGE === 'pg-live-select') {
  var LivePg = require('pg-live-select');
  reactiveQueries = new LivePg(CONN_STR, 'my_channel');
}
else if (PACKAGE === 'pg-live-query') {

}
else {
  throw Error("Unknown package to test.");
}

console.log("Installing data...");

// Install sample dataset and begin test queries
install(pool, GEN_SETTINGS, function(error) {
  if(error) throw error;

  console.log('Data installed! Beginning test queries...');

  startTime = Date.now();

  // Record memory usage every second
  setInterval(recordMemory, 1000);
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
        var ready = false;
        handle.on('insert', function(row) {
          runState.eventCount++;

          if (!ready) {
            return;
          }

          var start = insertTimes[row.score_id];
          if(typeof start === 'undefined') {
            console.log('Unexpected update ' + row.score_id);
          } else {
            var now = Date.now();
            var elapsed = (now - startTime) / 1000;
            measurements.responseTimes.push([ elapsed, now - start ]);
            delete insertTimes[row.score_id];
          }
        });
        handle.on('ready', function() {
          ready = true;
        });
        handle.start();
      });
    }
    else if (PACKAGE === 'pg-live-select') {
      var first = true;

      reactiveQueries.select(reactiveQueryText, [ classId ]).on('update', function(diff, data) {
        runState.eventCount++;

        for (var i = 0; i < diff.added.length; i++) {
          // An update about initial scores.
          if (diff.added[i].score_id <= SCORES_COUNT) {
            continue;
          }
          var start = insertTimes[diff.added[i].score_id];
          if(typeof start === 'undefined') {
            console.log('Unexpected update ' + diff.added[i].score_id);
          } else {
            var now = Date.now();
            var elapsed = (now - startTime) / 1000;
            measurements.responseTimes.push([ elapsed, now - start ]);
            delete insertTimes[diff.added[i].score_id];
          }
        }
      });
    }
    else if (PACKAGE === 'pg-live-query') {

    }
  }

  QUERIES.forEach(function(description) {
    timeouts.push(setInterval(function() {
      pool.connect(function(error, client, done) {
        if(error) throw error;

        client.query(description.query, description.params(),
          function(error, result) {
            done();
            if(error) throw error;
          }
        );
      });
    }, 1000 / description.execPerSecond));
  });
});

