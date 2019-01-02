var randomString = require('random-strings');

var querySequence = require('./querySequence');

var indexes = {
  students: [ ],
  assignments: [ 'class_id' ],
  scores: [ 'score DESC', 'assignment_id', 'student_id' ]
};

// Generate abstract representation of sample dataset by passing 4 integers
function generate(classCount, assignPerClass, studentsPerClass, classesPerStudent) {
  var studentCount = Math.ceil(classCount / classesPerStudent) * studentsPerClass;
  var assignCount  = classCount * assignPerClass;
  var scoreCount   = assignCount * studentsPerClass;
  var i;

  var students = [];
  for(i = 0; i < studentCount; i++) {
    students.push({
      id   : i + 1,
      name : randomString.alphaLower(10)
    });
  }

  var assignments = [];
  for(i = 0; i < assignCount; i++) {
    assignments.push({
      id       : i + 1,
      class_id : (i % classCount) + 1,
      name     : randomString.alphaLower(10),
      value    : Math.ceil(Math.random() * 100)
    });
  }

  var scores = [];
  for(i = 0; i < scoreCount; i++) {
    var assignId = Math.floor(i / studentsPerClass) + 1;
    var baseStudent =
      Math.floor((assignments[assignId - 1].class_id - 1) / classesPerStudent);

    scores.push({
      id            : i + 1,
      assignment_id : assignId,
      student_id    : (baseStudent * studentsPerClass) +
                      (i % studentsPerClass) + 1,
      score         : Math.ceil(Math.random() * assignments[assignId - 1].value)
    });
  }

  return {
    assignments: assignments,
    students: students,
    scores: scores
  };
}

function columnTypeFromName(name) {
  switch(name){
    case 'id'   : return 'serial NOT NULL';
    case 'name' : return 'character varying(50) NOT NULL';
    default     : return 'integer NOT NULL';
  }
}

// Generate and install sample dataset
module.exports = function(pool, settings, callback) {
  var queries = [];
  var data = generate.apply(null, settings);

  for(var table in data) {
    queries.push('DROP TABLE IF EXISTS ' + table);

    queries.push(
      'CREATE TABLE ' + table + ' (' +
        Object.keys(data[table][0]).map(function(column) {
          return column + ' ' + columnTypeFromName(column);
        }).join(', ') + ', ' +
        'CONSTRAINT ' + table + '_pkey PRIMARY KEY (id))'
    );

    for(var i = 0; i < indexes[table].length; i++) {
      queries.push('CREATE INDEX ON ' + table + ' (' + indexes[table][i] + ')');
    }

    var chunkLength = 500;
    var chunkCount = Math.ceil(data[table].length / chunkLength);
    for(var i = 0; i < chunkCount; i++) {
      var rows = [];
      for(var r = 0; r < chunkLength; r++) {
        var ci = (i * chunkLength) + r;
        if(ci >= data[table].length) break;
        rows.push('(' +
          Object.keys(data[table][0]).map(function(column) {
            var value = data[table][ci][column];
            return typeof value === 'number' ? value : '\'' + value + '\'';
          }).join(', ') + ')');
      }
      queries.push(
        'INSERT INTO ' + table +
        ' (' + Object.keys(data[table][0]).join(', ') + ') VALUES ' +
        rows.join(', ')
      );
    }
  }

  querySequence(pool, queries, callback);
};
