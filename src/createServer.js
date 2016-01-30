var ursa=require("./ursa");
var crypto = require('crypto');
var yggserver = require('yggdrasil').server({});
var states = require("./states");
var bufferEqual = require('buffer-equal');
var Server = require('./server');
var UUID = require('uuid-1345');

module.exports=createServer;

function createServer(options) {
  options = options || {};
  var port = options.port != null ?
    options.port :
    options['server-port'] != null ?
      options['server-port'] :
      25565;
  var host = options.host || '0.0.0.0';
  var kickTimeout = options.kickTimeout || 10 * 1000;
  var checkTimeoutInterval = options.checkTimeoutInterval || 4 * 1000;
  var onlineMode = options['online-mode'] == null ? true : options['online-mode'];
  // a function receiving the default status object and the client
  // and returning a modified response object.
  var beforePing = options.beforePing || null;

  var enableKeepAlive = options.keepAlive == null ? true : options.keepAlive;

  var optVersion = options.version || require("./version").defaultVersion;
  var mcData=require("minecraft-data")(optVersion);
  var version = mcData.version;

  var serverKey = ursa.generatePrivateKey(1024);

  var server = new Server(version.majorVersion);
  server.motd = options.motd || "A Minecraft server";
  server.maxPlayers = options['max-players'] || 20;
  server.playerCount = 0;
  server.onlineModeExceptions = {};
  server.on("connection", function(client) {
    client.once('set_protocol', onHandshake);
    client.once('login_start', onLogin);
    client.once('ping_start', onPing);
    client.once('legacy_server_list_ping', onLegacyPing);
    client.on('end', onEnd);

    var keepAlive = false;
    var loggedIn = false;
    var lastKeepAlive = null;

    var keepAliveTimer = null;
    var loginKickTimer = setTimeout(kickForNotLoggingIn, kickTimeout);

    var serverId;
    
    var sendKeepAliveTime;

    function kickForNotLoggingIn() {
      client.end('LoginTimeout');
    }

    function keepAliveLoop() {
      if(!keepAlive)
        return;

      // check if the last keepAlive was too long ago (kickTimeout)
      var elapsed = new Date() - lastKeepAlive;
      if(elapsed > kickTimeout) {
        client.end('KeepAliveTimeout');
        return;
      }
      sendKeepAliveTime = new Date();
      client.write('keep_alive', {
        keepAliveId: Math.floor(Math.random() * 2147483648)
      });
    }

    function onKeepAlive() {
      if(sendKeepAliveTime) client.latency = (new Date()) - sendKeepAliveTime;
      lastKeepAlive = new Date();
    }

    function startKeepAlive() {
      keepAlive = true;
      lastKeepAlive = new Date();
      keepAliveTimer = setInterval(keepAliveLoop, checkTimeoutInterval);
      client.on('keep_alive', onKeepAlive);
    }

    function onEnd() {
      clearInterval(keepAliveTimer);
      clearTimeout(loginKickTimer);
    }

    function onPing() {
      var response = {
        "version": {
          "name": version.minecraftVersion,
          "protocol": version.version
        },
        "players": {
          "max": server.maxPlayers,
          "online": server.playerCount,
          "sample": []
        },
        "description": {"text": server.motd},
        "favicon": server.favicon
      };

      function answerToPing(err, response) {
        if ( err ) return;
        client.write('server_info', {response: JSON.stringify(response)});
      }

      if(beforePing) {
        if ( beforePing.length > 2 ) {
          beforePing(response, client, answerToPing);
        } else {
          answerToPing(null, beforePing(response, client) || response);
        }
      } else {
        answerToPing(null, response);
      }

      client.once('ping', function(packet) {
        client.write('ping', {time: packet.time});
        client.end();
      });
    }

    function onLegacyPing(packet) {
      console.log('onLegacyPing',packet);
      if (packet.payload === 0) {
        var responseString = [server.motd, server.playerCount.toString(), server.maxPlayers.toString()].join('\xa7');

        function utf16be(s) {
          //var responseBuffer = new Buffer(responseString, 'utf16le'); // unfortunately, we need utf16be not le
          //var responseBuffer = new Buffer(responseString, 'ucs2'); // aliases for utf16le
          // hack semi-UTF16BE encoding, by prefixing each character with a null byte
          // TODO: use a real encoder, maybe https://github.com/ForbesLindesay/legacy-encoding?
          // uses https://github.com/ashtuchkin/iconv-lite which has 'utf16-be'. use or separate out?
          return new Buffer([''].concat(s.split('')).join('\0'), 'binary');
        }

        var responseBuffer = utf16be(responseString);

        var length = responseString.length; // UCS2 characters, not bytes
        var lengthBuffer = new Buffer(2);
        lengthBuffer.writeUInt16BE(length);

        client.writeRaw(Buffer.concat([new Buffer('ff', 'hex'), lengthBuffer, responseBuffer]));
      }
      // TODO: support ping type 1
    }

    function onLogin(packet) {
      client.username = packet.username;
      var isException = !!server.onlineModeExceptions[client.username.toLowerCase()];
      var needToVerify = (onlineMode && !isException) || (!onlineMode && isException);
      if(needToVerify) {
        serverId = crypto.randomBytes(4).toString('hex');
        client.verifyToken = crypto.randomBytes(4);
        var publicKeyStrArr = serverKey.toPublicPem("utf8").split("\n");
        var publicKeyStr = "";
        for(var i = 1; i < publicKeyStrArr.length - 2; i++) {
          publicKeyStr += publicKeyStrArr[i]
        }
        client.publicKey = new Buffer(publicKeyStr, 'base64');
        client.once('encryption_begin', onEncryptionKeyResponse);
        client.write('encryption_begin', {
          serverId: serverId,
          publicKey: client.publicKey,
          verifyToken: client.verifyToken
        });
      } else {
        loginClient();
      }
    }

    function onHandshake(packet) {
      client.serverHost = packet.serverHost;
      client.serverPort = packet.serverPort;
      client.protocolVersion = packet.protocolVersion;
      if(packet.nextState == 1) {
        client.state = states.STATUS;
      } else if(packet.nextState == 2) {
        client.state = states.LOGIN;
      }
      if(client.protocolVersion!=version.version)
      {
        client.end("Wrong protocol version, expected: "+version.version+" and you are using: "+client.protocolVersion);
      }
    }

    function onEncryptionKeyResponse(packet) {
      try {
        var verifyToken = serverKey.decrypt(packet.verifyToken, undefined, undefined, ursa.RSA_PKCS1_PADDING);
        if(!bufferEqual(client.verifyToken, verifyToken)) {
          client.end('DidNotEncryptVerifyTokenProperly');
          return;
        }
        var sharedSecret = serverKey.decrypt(packet.sharedSecret, undefined, undefined, ursa.RSA_PKCS1_PADDING);
      } catch(e) {
        client.end('DidNotEncryptVerifyTokenProperly');
        return;
      }
      client.setEncryption(sharedSecret);

      var isException = !!server.onlineModeExceptions[client.username.toLowerCase()];
      var needToVerify = (onlineMode && !isException) || (!onlineMode && isException);
      var nextStep = needToVerify ? verifyUsername : loginClient;
      nextStep();

      function verifyUsername() {
        yggserver.hasJoined(client.username, serverId, sharedSecret, client.publicKey, function(err, profile) {
          if(err) {
            client.end("Failed to verify username!");
            return;
          }
          // Convert to a valid UUID until the session server updates and does
          // it automatically
          client.uuid = profile.id.replace(/(\w{8})(\w{4})(\w{4})(\w{4})(\w{12})/, "$1-$2-$3-$4-$5");
          client.profile = profile;
          loginClient();
        });
      }
    }


    // https://github.com/openjdk-mirror/jdk7u-jdk/blob/f4d80957e89a19a29bb9f9807d2a28351ed7f7df/src/share/classes/java/util/UUID.java#L163
    function javaUUID(s)
    {
      var hash = crypto.createHash("md5");
      hash.update(s, 'utf8');
      var buffer = hash.digest();
      buffer[6] = (buffer[6] & 0x0f) | 0x30;
      buffer[8] = (buffer[8] & 0x3f) | 0x80;
      return buffer;
    }

    function nameToMcOfflineUUID(name)
    {
      return (new UUID(javaUUID("OfflinePlayer:"+name))).toString();
    }

    function loginClient() {
      var isException = !!server.onlineModeExceptions[client.username.toLowerCase()];
      if(onlineMode == false || isException) {
        client.uuid = nameToMcOfflineUUID(client.username);
      }
      client.write('compress', { threshold: 256 }); // Default threshold is 256
      client.compressionThreshold = 256;
      client.write('success', {uuid: client.uuid, username: client.username});
      client.state = states.PLAY;
      loggedIn = true;
      if(enableKeepAlive) startKeepAlive();

      clearTimeout(loginKickTimer);
      loginKickTimer = null;

      server.playerCount += 1;
      client.once('end', function() {
        server.playerCount -= 1;
      });
      server.emit('login', client);
    }
  });
  server.listen(port, host);
  return server;
}
