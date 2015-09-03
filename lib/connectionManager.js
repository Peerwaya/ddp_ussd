var http = require('http');
var sockjs = require('sockjs');
var sjsc = require('sockjs-client');
var tty = require('tty');
var util = require('util');
var _ = require('underscore');
var request = require('request');
var url = require('url');
var connectionManager
var proxyServer
var clientIds=0;
var Modem=require('gsm-modem');
var sms_pdu = require('sms-pdu-node');

module.exports = function(meteorServerPort,proxyPort,ussdUrl) {
  connectionManager=new ConnectionManager(meteorServerPort,proxyPort,ussdUrl)
  connectionManager.connect();
};


function ProxyServer(connectionManager){
  this.connectionManager=connectionManager;
  this.sockjsServer = sockjs.createServer({
    prefix: '/sockjs',
    log: function() {},
    // we are proxying /sockjs/info to the actual app
    // hence we are using the middleware() of sockjs 
    // then it can't work with WebSockets
    websocket: false
  });
  this.middleware = this.sockjsServer.middleware();
  this.server = http.createServer(Object.getPrototypeOf(this).handleBrowserRequests.bind(this));
  this.sockjsServer.on('connection', Object.getPrototypeOf(this).onBrowserConnection.bind(this));
  this.server.listen(this.connectionManager.proxyPort);
}

ProxyServer.prototype = {
  clientIds: 0,

  handleBrowserRequests: function(req,res){
    var parsedUrl = url.parse(req.url);

      if(parsedUrl.pathname == "/sockjs/info") {

      // we need to forward info request to the actual app
      // otherwise Meteor reconnect logic goes crazy
      var meteorAppInfoUrl = this.connectionManager.meteorServerDomain + req.url;
      request.get(meteorAppInfoUrl, function(err, r, body) {
        if(err) {
          console.log("ERROR: ",err);
          res.end();
        } else {
          res.writeHead(r.statusCode, r.headers);
          res.end(body);
        }
      });
    } else {
      this.middleware(req, res);
    }
  },

  onBrowserConnection: function(conn){
      //console.log("New Connection : ",conn);
      this.connectionManager.addClient(conn);
  }
}

function Client(connectionManager,conn){
  this.conn=conn;
  //this.sessionId=conn.sessionId;
  this.connectionManager=connectionManager;
  //console.log("CLIENT ID : "+conn.id)
  this.clientId=conn.id//Math.random() * 4294967295;
  this.closeBrowserConnection = _.once(conn.close.bind(conn));
  this.conn.on('data',Object.getPrototypeOf(this).onClientData.bind(this));
  this.conn.on('close', Object.getPrototypeOf(this).onConnectionClose.bind(this));
  this.meteor=sjsc.create(this.connectionManager.meteorServerUrl);
  this.meteor.on('data',Object.getPrototypeOf(this).onMeteorServerData.bind(this));
  this.meteor.on('error', Object.getPrototypeOf(this).onMeteorServerError.bind(this));
  this.meteor.on('close', Object.getPrototypeOf(this).onMeteorServerClose.bind(this));
}

Client.prototype = {

  onClientData: function(message){
    if(this.connectionManager.ddpMode){
        this.meteor.write(message);
    }else{
        this.connectionManager.sendMessageWithUssd(this,message);
    }
  },

  onMeteorServerData: function(message){
    this.conn.write(message);
  },
  onUSSDData: function(message){
    this.conn.write(message);
  },

  onConnectionClose: function(){
    //could this be a network issue or is this the right place to try USSD?
    this.connectionManager.onClientConnectionClosed(this)
  },

  onMeteorServerError: function(error){
    //notify manager to trigger ussd failover
    this.connectionManager.onClientConnectionError(this,error)
    this.meteor.close();
  }
   ,onMeteorServerClose: function(){
    //notify manager to trigger ussd failover
    this.connectionManager.onClientConnectionError(this)
  }
}

/** This Object is responsible for monitoring the connection state with the
server. It should detect when connection is inactive and fail to USSD
**/

function ConnectionManager(meteorServerPort,proxyPort,ussdUrl){
  this.meteorServerPort=meteorServerPort;
  this.proxyPort=proxyPort;
  this.meteorServerDomain='http://localhost:' + this.meteorServerPort
  this.meteorServerUrl=this.meteorServerDomain + '/sockjs';
  this.ussdServerUrl=ussdUrl;
  this.clients = []
  this.proxyServer=new ProxyServer(this);
  this.ussdSocket=new USSDSocket();
}

ConnectionManager.prototype = {

  ddpMode:   true,
  isConnected: false,
  retries: 0,

  _connectToDDPServer: function(){
    this.meteorServerSocket = sjsc.create(this.meteorServerUrl);
    this.meteorServerSocket.on('error', this.onConnectionError.bind(this));
    this.meteorServerSocket.on('data',this.onData.bind(this));
    this.meteorServerSocket.on('close',this.onConnectionError.bind(this));
  },

  onData: function(data){
    var data=JSON.parse(data)
     console.log('RECIEVED DATA',data);
      if(data.server_id){
          this.server_id=data.server_id
          //we are connected to a server now
          this.isConnected=true;
          this.ddpMode=true;
          this.retries=0;
      }
  },

  _connectToUSSDServer: function(){
    if(this.ddpMode){
      //this.ddpMode=false;
      console.log('SHOULD ACTIVATE USSD');
    }else{
      //this.ddpMode=false;
      console.log('ALREADY ACTIVATED USSD');
    }
  },

  connect: function(){
    if(this.ddpMode){
      this._connectToDDPServer();
    }else{
      this._connectToUSSDServer();
    }
  },

  sendMessageWithUssd:function(connection,data){
      console.log("USSD FAIL-OVER")
  },

  addClient: function(conn){
    var connection=this.getClientFromConnection(conn)
    if(!connection){
        this.clients.push(new Client(this,conn))
    } 
  },

  removeClient: function(conn){
    var connection=this.getClientFromConnection(conn)
    if (connection){
      var i=this.clients.indexOf(connection);
      this.clients.splice(i,1)
    }
  },

   onConnectionError: function(error){
      console.log("ERROR : "+error);
      //Do we connect instantly to ussd or wait after X attemts to reconnect back to ddp?, 
      this._connectToUSSDServer();
      this.reconnectDDP();
   },

   onClientConnectionError: function(client,error){
      //do something with client
      //We failover to USSD
      this.onConnectionError(error);
   },

   onClientConnectionClosed: function(client){
      //client connection closed, do we failover to USSD? or fail silently
   },

    getClientFromConnection: function(conn){
      return _.findWhere(this.clients, {_conn: conn});
    },

    getClientFromClientId: function(clientId){
      return _.findWhere(this.clients, {clientId: clientId});
    },

    reconnectDDP: function(){
       var backoff = Math.pow(this.retries, 3)* 1000;
       setTimeout(this._connectToDDPServer.bind(this), backoff);
       this.retries++;
       console.log("RECONNECTING...");
    }

  }

function USSDSocket(modem,device){
  this.modem= new Modem({port : '/dev/tty.ZTEUSBModem_',ussdTimeout: 30000});
  this.modem.connect(this.onOpen.bind(this));
  this.connected=false; 
  this.sessions=[]
}

USSDSocket.prototype = {
    onOpen: function(err){
        if (err) {
            console.error('Error connecting modem: ', err);
            return;
        }
    console.error('connected modem: ', this.modem.portConnected);
    this.connected=true;
    this.modem.on('USSD',this.onUSSD.bind(this));
    var ussd='*131#'
    console.log("ussd",ussd);
    this.modem.getUSSD(ussd,this.onSend.bind(this))
    console.log("Manufacturer : "+this.modem.manufacturer);
  },
    onUSSD: function(data){
        console.log("data : "+data);
    },
  onSend: function(err,data){
    if (err) {
        console.error('Error sending ussd command: ', err);
        return;
    }
    console.log("data : "+data);
  },

  onDisconnect: function(data){
    console.log("data : "+data);
  },
  
  parseResponse: function(response_code, message){
     console.log("RESPONSE CODE : "+response_code)
     console.log("MESSAGE : "+message)
     this.close();
    
     var match = message.match(/([0-9,\,]+)\sRial/);
        if(!match) {
            if(this.callback)
                this.callback(false);
            return ;
        }
 
 
        if(this.callback)
            this.callback(match[1]);
  },

  onDeliver: function(details){
    console.log("DETAILS : "+details);
  }
}



