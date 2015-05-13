var fs = require('fs');
var babar = require('babar');
var pg = require('pg');
var randomString = require('random-strings');
var LivePg = require('pg-live-select');

var install = require('./lib/install');

// Connect to this database
var CONN_STR = 'postgres://meteor:meteor@127.0.0.1/meteor_test';
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


var runState = {
  eventCount: 0,
  scoresCount: SCORES_COUNT
};

var insertTimes = {};

// Description of queries to perform
var QUERIES = [
//   {
//     execPerSecond: 800, // Number of times to execute query per second
//     query: fs.readFileSync('testquery.sql').toString(),
//     params: function() {
//       runState.eventCount++
//       var classId = (runState.eventCount % GEN_SETTINGS[0]) + 1;
//       var oldHashes = [];
//       for(var i = 0; i < 100; i++) {
//         oldHashes.push('\'' + randomString.alphaLower(32) + '\'');
//       }
//       return [ classId, oldHashes ];
//     }
//   },
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

  for(var i in memSnapshots) {
    if(i === 'responseTimes') continue;
    memSnapshots[i].push([ elapsed, memUsage[i] / 1024 / 1024 ]);
  }

  process.stdout.write('\r ' + Math.floor(elapsed) + ' seconds elapsed...');
}, 1000);

// Save and display output on Ctrl+C
process.on('SIGINT', function() {
  if(process.argv.length > 2) {
    try {
      fs.writeFileSync(process.argv[2], JSON.stringify(memSnapshots));
    } catch(err) {
      console.error('Unable to save output!');
    }
  }

  console.log('\n Final Runtime Status:', runState);

  for(var i in memSnapshots) {
    console.log(babar(memSnapshots[i], { caption: i }));
  }

  liveDb.cleanup(process.exit);
});

var liveDb = new LivePg(CONN_STR, 'my_channel');

// Install sample dataset and begin test queries
install(CONN_STR, GEN_SETTINGS, function(error) {
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
    setInterval(function() {
      pg.connect(CONN_STR, function(error, client, done) {
        if(error) throw error;

        client.query(description.query, description.params(),
          function(error, result) {
            done();
            if(error) throw error;
          }
        );
      });
    }, 1000 / description.execPerSecond);
  });
});

