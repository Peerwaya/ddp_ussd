var commander = require('commander');
var connectionManager = require('./lib/connectionManager');
var optionsParser = commander
  .version(require('./package.json').version)
  .option('-m, --meteorPort <port>', 'Meteor App Port [default: 3000]', 3000)
  .option('-p, --proxyPort <port>', 'DDP Proxy Port [default: 3030]', 3030)
  .option('-u, --ussdUrl <ussd>', 'USSD URL [default: xxx]', "")
  .option('-v, --version', 'print version', false);

var argv = optionsParser.parse(process.argv);
connectionManager(argv.meteorPort, argv.proxyPort, argv.ussdUrl);


var serialport = require('serialport');
var SerialPort = serialport.SerialPort;

// list serial ports:
serialport.list(function (err, ports) {
  ports.forEach(function(port) {
    console.log(port.comName);
  });
});





