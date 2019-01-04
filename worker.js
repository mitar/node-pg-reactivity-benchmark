// We use a worker to store measurements so that they do not
// get counted towards used memory of main process.

var {parentPort} = require('worker_threads');

var measurements = { heapTotal: [], heapUsed: [], responseTimes: [] };

parentPort.on('message', function(message) {
  if (message.type === 'heapTotal') {
    measurements.heapTotal.push(message.value);
  }
  else if (message.type === 'heapUsed') {
    measurements.heapUsed.push(message.value);
  }
  else if (message.type === 'responseTimes') {
    measurements.responseTimes.push(message.value);
  }
  else if (message.type === 'get') {
    parentPort.postMessage(measurements);
  }
  else {
    throw new Error("Unknown message type: " + message.type);
  }
});
