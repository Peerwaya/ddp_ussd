var http = require('http');
var sockjs = require('sockjs');
var sjsc = require('sockjs-client');
var tty = require('tty');
var util = require('util');
var _ = require('underscore');
var request = require('request');
var Modem=require('gsm-modem');
var when = require('when');
var url = require('url');
var connectionManager
var proxyServer
var clientIds=0;

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
        var self=this;
        this.connectionManager.sendMessageWithUssd(message).then(function(data){
                console.log("DATA",data);
        }).catch(function(err){
                console.log("ERROR",err);
        });
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
      this.ddpMode=false;
      if(!this.ussdSocket){
          this.ussdSocket=new USSDSocket(this);
      }
    }
  },

  connect: function(){
    if(this.ddpMode){
      this._connectToDDPServer();
    }else{
      this._connectToUSSDServer();
    }
  },

  sendMessageWithUssd:function(data){
      console.log("USSD FAIL-OVER")
      return this.ussdSocket.send(data);
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

function USSDSocket(connectionManager){
  this.connectionManager=connectionManager;
  this.modem= new Modem({
      port : '/dev/cu.ZTEUSBATPort_',
      ussdTimeout: 15000,
      onDisconnect : this.onDisconnect.bind(this)
  });
  this.modem.connect(this.onOpen.bind(this));
  this.connected=false; 
  this.sessions=[];
  this.channel="*127*";
}

USSDSocket.prototype = {
    onOpen: function(err){
        if (err) {
            console.error('Error connecting modem: ', err);
            return;
        }
    console.log('connected modem: ', this.modem.portConnected);
    this.connected=true;
    this.modem.on('USSD',this.onUSSD.bind(this));

  },

    onDisconnect: function(error,data){
        console.log("modem disconnected : "+error);
    },

    onUSSD: function(data){
        console.log("on ussd : "+data);
    },

    send: function(data){
        console.log("SEND DATA : "+data);
        //
        /**
         * Challenge => Convert DDP DATA <=> USSD DATA e.g *channel*data#
         * Which format do we use? e.g *channel*UUID*DATA#
         * Issues,
         * 1)What if data cannot fit into the 182 chars with 7bit encoding scheme
         * 2)How do we packetize & depacketize the data to units that are <= 182 chars
         * 3)if we pack data, won't we lose the session  because USSD is session based?
         *
         */
        var data=JSON.stringify(data);
        var request=this.channel+this._generateId()+"*"+data
        console.log("REQUEST : "+request);
        console.log("REQUEST SIZE : "+request.length);
        request="#124#"
        var self=this;
        var promise = when.promise(function(resolve, reject, notify) {
            self.modem.getUSSD(request,function(err, data){
                if(err){
                    console.error('Error sending ussd command: ', err);
                    reject(err);
                }else{
                    //Convert USSD DATA => DDP DATA
                    console.log("got USSD response : "+data);
                    resolve(data);
                }
            });
        });
        return promise;
    },
  _generateId: function(){
      return Math.random() * 4294967295
  },
  onDisconnect: function(data){
    console.log("data : "+data);
  }
}



