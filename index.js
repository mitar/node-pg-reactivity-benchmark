var fs = require('fs');
var babar = require('babar');
var Pool = require('pg').Pool;
var LivePg = require('pg-live-select');

var install = require('./lib/install');

// Connect to this database
var CONN_STR = 'postgres://postgres:pass@127.0.0.1/postgres';
// Generate this much sample data (see lib/install.js)
var GEN_SETTINGS = [
  200, // class count
  30, // assignments per class
  20, // students per class
  6  // classes per student
];

// Instantiate this many liveselect objects
var LIVE_SELECT_COUNT = 50;

// Relative to generated data set
var ASSIGN_COUNT = GEN_SETTINGS[0] * GEN_SETTINGS[1];
var STUDENT_COUNT = Math.ceil(GEN_SETTINGS[0] / GEN_SETTINGS[3]) * GEN_SETTINGS[2];
var SCORES_COUNT = ASSIGN_COUNT * GEN_SETTINGS[2];

var pool = new Pool({
  connectionString: CONN_STR,
});

var runState = {
  eventCount: 0,
  scoresCount: SCORES_COUNT
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
      insertTimes[++runState.scoresCount] = Date.now();
      return [
        runState.scoresCount,
        Math.ceil(Math.random() * ASSIGN_COUNT),
        Math.ceil(Math.random() * STUDENT_COUNT),
        Math.ceil(Math.random() * 100)
      ];
    }
  }
];

// Record memory usage every second
var startTime = Date.now();
var memSnapshots = { heapTotal: [], heapUsed: [], responseTimes: [] };

var memInterval = setInterval(function() {
  var memUsage = process.memoryUsage();
  var elapsed = (Date.now() - startTime) / 1000;

  memSnapshots.heapTotal.push([ elapsed, memUsage.heapTotal / 1024 / 1024 ]);
  memSnapshots.heapUsed.push([ elapsed, memUsage.heapUsed / 1024 / 1024 ]);

  process.stdout.write('\r ' + Math.floor(elapsed) + ' seconds elapsed...');
}, 1000);

// Save and display output on Ctrl+C
process.on('SIGINT', function() {
  while (timeouts.length) {
    clearTimeout(timeouts.shift());
  }

  if(process.argv.length > 2) {
    try {
      fs.writeFileSync(process.argv[2], JSON.stringify(memSnapshots));
    } catch(err) {
      console.error('Unable to save output!');
    }
  }

  console.log('\n Final Runtime Status:', runState);

  console.log(babar(memSnapshots.heapTotal, { caption: "heapTotal (MB)" }));
  console.log(babar(memSnapshots.heapUsed, { caption: "heapUsed (MB)" }));
  console.log(babar(memSnapshots.responseTimes, { caption: "responseTimes (ms)" }));

  liveDb.cleanup(process.exit);

  pool.end();
});

var liveDb = new LivePg(CONN_STR, 'my_channel');

// Install sample dataset and begin test queries
install(pool, GEN_SETTINGS, function(error) {
  if(error) throw error;

  console.log('Data installed! Beginning test queries...');

  var liveQueryText = fs.readFileSync('livequery.sql').toString();
  for(var classId = 1; classId < LIVE_SELECT_COUNT + 1; classId++) {
    liveDb.select(liveQueryText, [ classId ])
      .on('update', function(diff, data) {
        if(diff && diff.added && diff.added.length === 1) {
          var start = insertTimes[diff.added[0].score_id];
          if(typeof start === undefined) {
            console.log('Unexpected update ' + diff.added[0].score_id);
          } else {
            var elapsed = (Date.now() - startTime) / 1000;
            memSnapshots.responseTimes.push([ elapsed, Date.now() - start ]);
            delete insertTimes[diff.added[0].score_id];
          }
        }

        runState.eventCount++;
      });
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

