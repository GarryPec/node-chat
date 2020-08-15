var app = require('express')();
var express = require('express');
var http = require('http').Server(app);
var io = require('socket.io')(http);
var fs = require('fs');
var mysql = require('mysql');
var validator = require('validator');
var siofu = require("socketio-file-upload");
var request = require('request');

//Image uploading
app.use(siofu.router);

var maxImageSize = 150; //150kb

//Globals:

var connections = [];
var channels = [];

var version = "v1.0";

//list of words that can't appear in usernames/channel names...  loaded from filter.txt
var filterList = fs.readFileSync(process.cwd() + '/filter.txt').toString().split("\r\n");

//SQL Stuff:
var listenPort = 80;
var poolConfig = {
    connectionLimit : 50, //important
    host     : 'localhost',
    user     : 'root',
    password : '',
    port : '3306',
    database : 'chat',
    debug    :  false
};
if (process.env.NODE_DEBUG && process.env.NODE_DEBUG == 'true') {
    poolConfig.password = 'tr41n1ng';
    poolConfig.port = '3306';
    listenPort = 3000;
}
var pool      =    mysql.createPool(poolConfig);

function handle_database_login(con, nickname, password, age, gender, location, additionalInfo)
{
    pool.getConnection(function(err,connection){
	
        if (err) {
          connection.release();
          console.log("database error: " + err);
        }
       
        connection.query("select * from users where nickname='" + nickname + "' AND passwordHash='" + password + "';",function(err,rows){
            connection.release();
            if(!err) {
			
                if(rows.length == 1)
				{
					simpleQueryCallBack("select * from serverbans where nickname='" + nickname + "';", function(banRows)
					{
						if(banRows.length == 0)
						{
							var ageN = age;
							var genderN = gender;
							var locationN = location;
							var additionalInfoN = additionalInfo;

							//if the user has entered values into the login boxes then update them, if not get them from the db from last time
							
							if(ageN == "") { ageN = rows[0].age; }
							if(genderN == "") { genderN = rows[0].gender; }
							if(locationN == "") { locationN = rows[0].location; }
							if(additionalInfoN == "") { additionalInfoN = rows[0].additionalInfo; }
						
							con.user = new User(rows[0].nickname, rows[0].accountType, ageN, genderN, locationN, additionalInfoN, rows[0].email, rows[0].profileImage, false);
							con.user.ip = con.ip;
							
							//update the database if values have changed
							
							if(rows[0].age != ageN || rows[0].gender != genderN || rows[0].location != locationN || rows[0].additionalInfo != additionalInfoN)
							{
								executeSimpleQuery("update users set age=" + ageN + ", gender='" + genderN + "', location='" + locationN + "', additionalInfo='" + additionalInfoN + "' where nickname='" + nickname + "'");
							}
							
							//Enable image uploads now...
							
							var uploader = new siofu();
							uploader.dir = process.cwd() + "/public/profIms";
							
							uploader.maxFileSize = maxImageSize * 1000;
							
							uploader.on("error", function(event){
								console.log("Error from uploader", event);
							});
							
							uploader.on("start", function(event)
							{
								var extension = event.file.name.split('.').pop();
								if(extension == 'jpg' || extension == 'jpeg' || extension == 'png' || extension == 'gif')
								{
									//rename to user's nickname + whatever extension the image is
									event.file.name = con.user.nickname + '.' + extension;
								}
							});
							
							uploader.on("saved", function(event)
							{
								if((event.file.name.endsWith(".jpg") || event.file.name.endsWith(".png") || event.file.name.endsWith(".jpeg") || event.file.name.endsWith(".gif")) == false)
								{
									console.log(con.user.nickname + " tried to upload " + event.file.name + " which is not .jpg, .jpeg, .gif or .png...");
									console.log("deleting...");

									fs.unlink(process.cwd() + "/public/profIms/" + event.file.name, function (err)
									{
									  if (err) throw err;
									  console.log("successfully deleted " + process.cwd() + "/public/profIms/" + event.file.name);
									});
								}
								else
								{
									con.user.profileImage = event.file.name;
									
									findChannelByName(con.user.currentChannel).sendEvent('user updated', JSON.stringify(con.user));
									
									executeSimpleQuery("update users set profileImage='" + event.file.name + "' where nickname='" + con.user.nickname + "'");
								}
							});
							
							uploader.listen(con.con);
							
							con.con.emit('login result', JSON.stringify(con.user));
							
							con.user.sendChannelList();
							//swapped these
							//findChannelByName("Kletshoek").addToChannel(con.user);
						}
						else
						{
							if(banRows[0].unbanTimestamp > Date.now())
							{
								con.con.emit('login result', 'banned|' + 'Je bent verbannen door ' + banRows[0].bannedBy + ' tot ' + Date(banRows[0].unbanTimestamp).toString());
								con.con.disconnect();
							}
							else
							{
								executeSimpleQuery("delete from serverbans where nickname='" + nickname + "'");
								con.con.emit('login result', 'banned|' + 'Je hebt weer toegang tot de chatserver, log opnieuw in.');
							}
						}
					});
				
					
				}
				else
				{
					con.con.emit('login result', 'fail');
				}
            }
        });
  });
}

function handle_database_channels_load()
{
	pool.getConnection(function(err,connection){
	
        if (err) {
          console.log("database error: " + err);
        }
       
        connection.query("select * from channels;",function(err,rows){
			console.log("started channel loading from database");
            connection.release();
            if(!err) {
				for (var i = 0; i < rows.length; i++)
				{
					var thisChannelFromDB = new Channel(rows[i].name, rows[i].owner, rows[i].topic, rows[i].type, "", rows[i].isStatic);
					thisChannelFromDB.loadPermissionsFromDatabase();
				}
            }
        });
	});
}

function executeSimpleQuery(queryString)
{
	pool.getConnection(function(err,connection){
	
		if (err) {
		  connection.release();
		  console.log("database error: " + err);
		}
	
		connection.query(queryString ,function(err,rows){
			connection.release();
		});
	});
}

function simpleQueryCallBack(queryString, callBackFunc)
{
	pool.getConnection(function(err,connection){
	
		if (err) {
		  connection.release();
		  console.log("database error: " + err);
		}
	
		connection.query(queryString ,function(err,rows){
			connection.release();
			callBackFunc(rows);
		});
	});
}

function handle_database_registration(con, nickname, passwordHash, email)
{
	nickname = validator.escape(nickname);
	passwordHash = validator.escape(passwordHash);
	email = validator.escape(email);

	for(var filterIndex=0; filterIndex<filterList.length; filterIndex++)
	{
		if(nickname.includes(filterList[filterIndex]))
		{
			con.con.emit('register result', 'forbidden term');
			return;
		}
	}
	
	if(validator.isLength(nickname, 3, 20) == false || nickname.indexOf(" ") > -1)
	{
		con.con.emit('register result', 'nickname wrong');
		return;
	}
	
	if(validator.isLength(passwordHash, 32, 32) == false)
	{
		con.con.emit('register result', 'password wrong');
		return;
	}
	
	if (validator.isEmail(email) == false)
	{
		con.con.emit('register result', 'email wrong');
		return;
	}
	
	
   pool.getConnection(function(err,connection)
   {
		if (err) {
		  connection.release();
		  console.log("database error: " + err);
		}
	   
		connection.query("select * from users where nickname='" + nickname + "'",function(err,rows){
			connection.release();
			if(!err) {
			
				if(rows.length > 0)
				{					
					con.con.emit('register result', 'nickname taken');
					
				}
				else
				{
					//all good, proceed
					
					pool.getConnection(function(err2,connection2)
					{
							if (err2) {
							  connection2.release();
							  console.log("database error: " + err2);
							}
						   
							connection2.query("insert into users values('" + nickname + "', 0, '" + passwordHash + "', 0, '', '', '', '" + email + "', 'none', 'server');",function(err,rows){
								connection2.release();
								if(!err2) {
									
									con.con.emit('register result', 'ok');
								}
							});

							connection2.on('error', function(err2) {      
								  console.log("database error: " + err2);
								  con.user = null;
							});
					  });
				}
			}
		});
  });
}

//Set up page serving, i.e. handle / with index, everything with /static in front of it, grab from /public

app.use('/static', express.static('public'));

app.get('/', function(req, res){
  res.sendFile(__dirname + '/index.html');	
});

//Add starting channels
handle_database_channels_load();

//Listen for connections
http.listen(42526, function(){
  console.log('listening on *:' + listenPort);
});

//Event Handling:

io.on('connection', function(socket)
{
	//New connection, push a new Connection instance onto connections array, set User to null initially as they are not yet logged in
	console.log('new connection from ' + socket.request.connection._peername.address);
	connections.push(new Connection(null, socket, socket.request.connection._peername.address));
	
	//Connection lost, remove the Connection instance we made when it was established
	socket.on('disconnect', function()
	{
		console.log('a connection was finished from ' + socket.request.connection._peername.address);
		removeConnection(findConnectionBySocket(socket));
	});
	
	socket.on('error', function(msg)
	{
		console.log('Socket Error : ' + msg);
		console.log(msg.stack);
	});
	
	//Connection is attempting to login...
	//msg should be in form of nickname|md5hash of password
	socket.on('login request', function(msg)
	{
		msg = validator.escape(msg);
	
		console.log('login request');
		var thisCon = findConnectionBySocket(socket);
	
		simpleQueryCallBack("select * from serverbans where ip='" + thisCon.ip + "'", function(brows)
		{
			if(brows.length > 0)
			{
				if(brows[0].unbanTimestamp > Date.now())
				{
					thisCon.con.emit('login result', 'banned|' + 'Je bent verbannen door ' + brows[0].bannedBy + ' tot ' + Date(brows[0].unbanTimestamp).toString());
					thisCon.con.disconnect();
				}
				else
				{
					executeSimpleQuery("delete from serverbans where ip='" + thisCon.ip + "'");
					thisCon.con.emit('login result', 'banned|' + 'Je hebt weer toegang tot de chatserver, log opnieuw in.');
				}
			}
			else
			{
				var msgParts = msg.split("|");
				//msgParts[0] = msgParts[0].toLowerCase();
			
				if(msgParts[0].length < 3)
				{
					socket.emit('login result', "fail|too short");
					return;
				}
				
				if(isUserLoggedIn(msgParts[0]) == true)
				{
					socket.emit('login result', "fail|logged in");
					return;
				}
				else if(msgParts[1] == "guest")
				{
					//i.e. user logging in as a guest
					
					//ensure the guest username isn't already taken by an actual user
						
					simpleQueryCallBack("select * from users where nickname='" + msgParts[0] + "'", function(rows)
					{
						if(rows.length == 0)
						{
							msgParts[0] = "~" + msgParts[0];
						
							if(isUserLoggedIn(msgParts[0]) == true)
							{
								//guest with that name already logged in
								socket.emit('login result', "fail|guest taken");
							}
							else
							{
								thisCon.user = new User(msgParts[0], 0, msgParts[2], msgParts[3], msgParts[4], msgParts[5], '', 'none', false);
								thisCon.user.ip = thisCon.ip;
								thisCon.con.emit('login result', JSON.stringify(thisCon.user));
								
								thisCon.user.sendChannelList();
								//swapped these
								//findChannelByName("Kletshoek").addToChannel(thisCon.user);
							}
						}
						else
						{
							//actual user with that name exists
							socket.emit('login result', "fail|actual user");
						}	
					});
				}
				else
				{
					handle_database_login(thisCon, msgParts[0], msgParts[1], msgParts[2], msgParts[3], msgParts[4], msgParts[5]);
				}
			}
		});
	});

	socket.on('send channel message', function(msg)
	{
		var sender = findConnectionBySocket(socket);
		
		//if(sender.user.xcdrvesl == true)
		//{
		//	sender.con.emit('server message', 'You can not send a message when you are hidden.');
		//}
		
		if(sender.user.bhdedl == false)
		{
		
			var receivedMessage = JSON.parse(msg);
			
			if(validator.isHexColor(receivedMessage.colour) == false)
			{
				receivedMessage.colour = "#000000";
			}
			
			
			// add handle youtube here
			processMessageContent(receivedMessage.content, function(content, isRawMessage) {
				var newMessage = new Message(sender.user.nickname, receivedMessage.colour, content, isRawMessage);
				
				for(var filterIndex=0; filterIndex<filterList.length; filterIndex++)
				{
					if(newMessage.content.includes(filterList[filterIndex]))
					{
						sender.con.emit('server message', 'The message you entered contains a forbidden phrase, please try again.');
						return;
					}
				}
			
				findChannelByName(sender.user.currentChannel).sendMessage(newMessage);
			});
		}
		else
		{
			sender.con.emit('server message', 'You do not have permission to talk on channel: ' + sender.user.currentChannel);
		}
	});
	
	socket.on('private message', function(msg)
	{	
		var msgParts = msg.split('|');
	
		var sender = findConnectionBySocket(socket);
		
		var receivedMessage = JSON.parse(msgParts[1]);
		
		if(validator.isHexColor(receivedMessage.colour) == false)
		{
			receivedMessage.colour = "#000000";
		}
		
		var newMessage = new Message(sender.user.nickname, receivedMessage.colour, validator.escape(receivedMessage.content));
		
		for(var filterIndex=0; filterIndex<filterList.length; filterIndex++)
		{
			if(newMessage.content.includes(filterList[filterIndex]))
			{
				sender.con.emit('server message', 'The message you entered contains a forbidden phrase, please try again.');
				return;
			}
		}
		
		var receiver = findUserFromStringName(msgParts[0]);
		
		if(receiver != null)
		{
			findConnectionFromUser(receiver).con.emit('private message', JSON.stringify(newMessage));
		}
	});
	
	socket.on('change channel', function(msg)
	{
		msg = validator.escape(msg);
		
		var thisUser = findConnectionBySocket(socket).user;
		
		if(thisUser != null)
		{
			thisUser.bhdedl = false;
			
			socket.emit('changed channel', msg);
			
			if(thisUser.currentChannel != "")
			{
				findChannelByName(thisUser.currentChannel).removeFromChannel(thisUser);
			}
			
			findChannelByName(msg).addToChannel(thisUser);
		}
	});
	
	socket.on('register request', function(msg)
	{
		msg = validator.escape(msg);
	
		var msgParts = msg.split("|");
		
		console.log('register request string: ' + msg)
		
		//(con, nickname, passwordHash, age, gender, location, additionalInfo, email) 
		
		handle_database_registration(findConnectionBySocket(socket), msgParts[0], msgParts[1], msgParts[2]);
	});
	
	socket.on('create channel', function(msg)
	{
		msg = validator.escape(msg);
		
		var msgParts = msg.split("|");
		var thisCon = findConnectionBySocket(socket);
		
		if(msgParts[0].indexOf(" ", 0) != -1)
		{
			thisCon.con.emit('server message', 'Kanaal naam mag geen spatie bevatten.');
			return;
		}
		
		if(msgParts[0].length < 3)
		{
			thisCon.con.emit('server message', 'Channel name must be 3 characters or more.');
			return;
		}
		
		if(findChannelByName(msgParts[0]) == null)
		{
			var cType = 0;
			
			if(msgParts[2] == "Admin")
			{
				cType = 1;
			}
			
			if(thisCon.user != null)
			{
				//add to database
				
				executeSimpleQuery("insert into channels values('" + msgParts[0] + "', '" + thisCon.user.nickname + "', '" + msgParts[1] + "', " + cType + ");");
				
				channels.push(new Channel(msgParts[0], thisCon.user.nickname, msgParts[1], cType, "", 0));
				
				executeSimpleQuery("insert into chatlogs values('" + msgParts[0] + "', '')");

				//Update all users as to the new channelArr
				for	(index = 0; index < connections.length; index++)
				{
					if(connections[index] != null)
					{
						if(connections[index].user != null)
						{
							connections[index].user.sendChannelList();
						}
					}
				}
				
				thisCon.user.bhdedl = false;
		
				socket.emit('changed channel', msgParts[0]);
				
				if(thisCon.user.currentChannel != "")
				{
					findChannelByName(thisCon.user.currentChannel).removeFromChannel(thisCon.user);
				}
				
				findChannelByName(msgParts[0]).addToChannel(thisCon.user);
			}
		}
		else
		{
			thisCon.con.emit('server message', 'Dit kanaal bestaat al.');
		}
	});
	
	socket.on('search', function(msg)
	{
		console.log('search: ' + msg);
	
		var thisCon = findConnectionBySocket(socket);
	
		var msgParts = msg.split("|");
	
		var searchList = [];
		var searchOn = msgParts[0];
		var gender = msgParts[1];
		var name = msgParts[2];
		
		for(var conIndex=0; conIndex<connections.length; conIndex++)
		{
			if(connections[conIndex] != null)
			{
				if(connections[conIndex].user != null)
				{
					var searchOnSatisfied = false;
					var genderSatifised = false;
					var nameSatisfied = false;
					
					if(searchOn == "Channel")
					{
						if(connections[conIndex].user.currentChannel == thisCon.user.currentChannel)
						{
							searchOnSatisfied = true;
						}
					}
					else
					{
						searchOnSatisfied = true;
					}
					
					if(gender != "both")
					{
						if(connections[conIndex].user.gender == gender)
						{
							genderSatifised = true;
						}
					}
					else
					{
						genderSatifised = true;
					}
					
					if(name != "")
					{
						if(connections[conIndex].user.nickname.includes(name))
						{
							nameSatisfied = true;
						}
					}
					else
					{
						nameSatisfied = true;
					}
					
					if(searchOnSatisfied == true && genderSatifised == true && nameSatisfied == true)
					{
						searchList.push(connections[conIndex].user);
					}
				}
			}
		}
		
		thisCon.con.emit('search result', JSON.stringify(searchList));
		
	});
	
	socket.on('command', function(msg)
	{
		//from db - level: 0=normal, 1=oper, 2=superuser, 3=cyber, 4=admin, 5=creator
		var thisCon = findConnectionBySocket(socket);
		
		if(thisCon.user != null)
		{
			var userChannel = findChannelByName(thisCon.user.currentChannel);
			var commandParts = msg.split(" ");
			
			if(commandParts[0] == "/part")
			{
				thisCon.con.emit('changed channel', 'Kletshoek');
			
				userChannel.removeFromChannel(thisCon.user);
				findChannelByName("Kletshoek").addToChannel(thisCon.user);
			}
			else if(commandParts[0] == "/wall")
			{
				if(thisCon.user.accountType == 3 || thisCon.user.accountType == 4)
				{
					//must be cyber or admin to use walls
					
					var messageParts = msg.replace("/wall ", "").split(" ");
					var parsedMessage = "";
					
					var firstCol = true;
					
					for(var partsIndex=0; partsIndex<messageParts.length; partsIndex++)
					{
						if(/(^#[0-9A-F]{6}$)|(^#[0-9A-F]{3}$)/i.test(messageParts[partsIndex]))
						{
							if(firstCol == true)
							{
								firstCol = false;
							}
							else
							{
								parsedMessage += "</span>";
							}
							
							parsedMessage += "<span style=\"color: " + messageParts[partsIndex] + "\">";
						}
						else
						{
							parsedMessage += " " + messageParts[partsIndex];
						}
					}
					
					if(firstCol == false)
					{
						parsedMessage += "</span>";
					}
					
					sendServerMessageToAllLoggedInUsers("ALGEMEEN BERICHT: " + parsedMessage);
				}
				else
				{
					thisCon.con.emit('server message', 'Deze actie is niet toegestaan');
				}
			}
			else if(commandParts[0] == "/whois")
			{
				var found = findUserFromStringName(msg.replace("/whois ", ""));
				
				if(found != null)
				{
					thisCon.con.emit('server message', found.nickname + ' is in kanaal ' + found.currentChannel);
				}
				else
				{
					thisCon.con.emit('server message', msg.replace("/whois ", "") + ' gebruiker niet ingelogd, of bestaat niet.');
				}
			}
			else if(commandParts[0] == "/op")
			{
				var userToUpgrade = findUserFromStringName(commandParts[1]);
				
				//First, check if the user actually exists
				if(userToUpgrade == null)
				{
					thisCon.con.emit('server message', 'That user is not logged in or does not exist');
					return;
				}
				
				var carryOut = false;
				var stopError = false;
				var positionToSet = convertUserLevelStringToInt(commandParts[2]);
				var ch = findChannelByName(userToUpgrade.currentChannel);
			
				//Next, check if the user is in the same channel as the user attempting the command
				if(userToUpgrade.currentChannel != thisCon.user.currentChannel)
				{
					thisCon.con.emit('server message', 'That user is not in the channel currently');
					return;
				}
				
				//Next, check if the account type was recognised
				if(positionToSet == null)
				{
					thisCon.con.emit('server message', 'Account type must be normal, oper, super, cyber or admin');
					return;
				}
			
				if(thisCon.user.accountType == 4 || (thisCon.user.accountType == 3 && userToUpgrade.accountType != 4 && positionToSet != 4))
				{
					//Admin/Cyber can op anyone to anything (as long as not cyber oping admin)
					
					carryOut = true;
				}
				else if(userToUpgrade.nickname == thisCon.user.nickname)
				{
					//i.e. this user is trying to perform an op command on themself...
					
					if(ch.creator == thisCon.user.nickname && positionToSet != 3 && positionToSet != 4)
					{
						//user is the channel creator, let them op to anything other than cyber or admin
						
						carryOut = true;
					}
					else if(positionToSet == 0 && thisCon.user.currentChannelUserLevel != 0)
					{
						//user is not normal already, but making themself normal now...
						
						carryOut = true;
					}
					else
					{
						//check if the user has autoop permissions
						stopError = true;
						
						simpleQueryCallBack("select * from channelrights where nickname='" + thisCon.user.nickname + "' and channelName='" + ch.name + "';", function(rows)
						{
							if(rows.length == 1)
							{
								//callback, so will be fired after the below so gotta duplicate
								
								if(rows[0].level == 5 && (positionToSet != 4 && positionToSet != 3))
								{
									carryOut = true;
								}
								else if(rows[0].level >= positionToSet)
								{
									carryOut = true;
								}
								
								if(carryOut == true)
								{
									userToUpgrade.currentChannelUserLevel = positionToSet;
									userToUpgrade.userWhoGave = thisCon.user.nickname;
									
									ch.sendEvent('user updated', JSON.stringify(userToUpgrade));
									
									ch.sendEvent('server message', thisCon.user.nickname + ' heeft ' + userToUpgrade.nickname + " " + commandParts[2] + " gemaakt op kanaal " + ch.name);
								}
								else
								{
									thisCon.con.emit('server message', 'Deze actie is niet toegestaan.');
									return;
								}
							}
							else
							{
								thisCon.con.emit('server message', 'Deze actie is niet toegestaan.');
								return;
							}
						});
					}
				}
				else
				{
					//i.e. this user is trying to perform an op command on a different user
					
					if(thisCon.user.currentChannelUserLevel == userToUpgrade.currentChannelUserLevel || compareUserLevels(thisCon.user.currentChannelUserLevel, userToUpgrade.currentChannelUserLevel))
					{
						carryOut = true;
					}
				}
				
				//now we know if the command should be carried and what level to set to:
				
				if(carryOut == true)
				{
					userToUpgrade.currentChannelUserLevel = positionToSet;
					userToUpgrade.userWhoGave = thisCon.user.nickname;
					
					ch.sendEvent('user updated', JSON.stringify(userToUpgrade));
					
					ch.sendEvent('server message', thisCon.user.nickname + ' heeft ' + userToUpgrade.nickname + " " + commandParts[2] + " gemaakt op kanaal " + ch.name);
				}
				else if(stopError == false)
				{
					thisCon.con.emit('server message', 'Deze actie is niet toegestaan.');
					return;
				}
			}
			else if(commandParts[0] == "/deop")
			{
				if(thisCon.user != null)
				{
					if(commandParts.length == 1)
					{
						//User deoping themself i.e. /deop
				
						var ch = findChannelByName(thisCon.user.currentChannel);
						
						//only available to super, oper
						if(thisCon.user.currentChannelUserLevel == 2 || thisCon.user.currentChannelUserLevel == 1 || thisCon.user.currentChannelUserLevel == 3 || thisCon.user.currentChannelUserLevel == 4)
						{
							/*if(thisCon.user.currentChannelUserLevel == 1)
							{
								for(var pIndex=0; pIndex<ch.permOperators.length; pIndex++)
								{
									if(ch.permOperators[pIndex] != null)
									{
										if(ch.permOperators[pIndex].nickname == thisCon.user.nickname)
										{
											ch.permOperators[pIndex] = null;
										}
									}
								}
							}
							else if(thisCon.user.currentChannelUserLevel == 2)
							{
								for(var pIndex=0; pIndex<ch.permSuperAdmins.length; pIndex++)
								{
									if(ch.permSuperAdmins[pIndex] != null)
									{
										if(ch.permSuperAdmins[pIndex].nickname == thisCon.user.nickname)
										{
											ch.permSuperAdmins[pIndex] = null;
										}
									}
								}
							}*/ //commented out this because got confused between /deop and /autodeop
						
							thisCon.user.currentChannelUserLevel = 0;
							
							ch.sendEvent('user updated', JSON.stringify(thisCon.user));
							
							ch.sendEvent('server message', thisCon.user.nickname + ' heeft ' + thisCon.user.nickname + ' normaal gemaakt op kanaal ' + ch.name);
						}
						else if(thisCon.user.currentChannelUserLevel == 5)
						{
							thisCon.user.currentChannelUserLevel = 0;
							
							ch.sendEvent('user updated', JSON.stringify(thisCon.user));
							
							ch.sendEvent('server message', thisCon.user.nickname + ' heeft ' + thisCon.user.nickname + ' normaal gemaakt op kanaal ' + ch.name);
						}
						else
						{
							thisCon.con.emit('server message', 'Deze actie is niet toegestaan.');
						}
					}
					else
					{
						//deoping someone else, i.e. /deop user
						
						if(thisCon.user.currentChannelUserLevel == 5 || thisCon.user.currentChannelUserLevel == 4 || thisCon.user.currentChannelUserLevel == 3 || thisCon.user.currentChannelUserLevel == 2)
						{
							var userToDowngrade = findUserFromStringName(commandParts[1]);
							
							if(userToDowngrade != null)
							{
								if(userToDowngrade.currentChannelUserLevel == 1 || userToDowngrade.currentChannelUserLevel == 2)
								{
									if(compareUserLevels(thisCon.user.currentChannelUserLevel, userToDowngrade.currentChannelUserLevel) || thisCon.user.currentChannelUserLevel == 4)  //rights check
									{
										if(thisCon.user.currentChannel != userToDowngrade.currentChannel)
										{
											thisCon.con.emit('server message', 'the user you specified is not in this channel at present.');
											return;
										}
									
										userToDowngrade.currentChannelUserLevel = 0
										userToDowngrade.userWhoGave = thisCon.user.nickname;
										
										var ch = findChannelByName(userToDowngrade.currentChannel);
										
										ch.sendEvent('user updated', JSON.stringify(userToDowngrade));
										
										ch.sendEvent('server message', thisCon.user.nickname + ' heeft ' + userToDowngrade.nickname + " normaal gemaakt op kanaal " + ch.name);
									}
									else
									{
										thisCon.con.emit('server message', 'Deze actie is niet toegestaan.');
									}
								}
								else
								{
									thisCon.con.emit('server message', 'That user is not oper or super, did you mean /sdeop?');
								}
							}
						}
						else
						{
							thisCon.con.emit('server message', 'Deze actie is niet toegestaan.');
						}
						
						//end here
					}
				}
			}
			else if(commandParts[0] == "/sdeop")
			{
				if(thisCon.user.accountType == 4)
				{
					var userToDowngrade = findUserFromStringName(commandParts[1]);
					
					if(userToDowngrade != null)
					{
						if(userToDowngrade.accountType == 3)
						{
							userToDowngrade.accountType = 0;
							userToDowngrade.currentChannelUserLevel = 0;
							
							var ch = findChannelByName(userToDowngrade.currentChannel);
							
							ch.sendEvent('user updated', JSON.stringify(userToDowngrade));
							
							ch.sendEvent('server message', thisCon.user.nickname + ' heeft ' + userToDowngrade.nickname + ' normaal gemaakt op kanaal ' + userToDowngrade.currentChannel + ' en tijdelijk blijvende rechten afgenomen.');
						}
					}
				}
				else
				{
					thisCon.con.emit('server message', 'Deze actie is niet toegestaan.');
				}
			}
			else if(commandParts[0] == "/autosdeop")
			{
				if(thisCon.user.accountType == 4)
				{
					var userToDowngrade = findUserFromStringName(commandParts[1]);
					
					if(userToDowngrade != null)
					{
						if(userToDowngrade.accountType == 3 || userToDowngrade.accountType == 4)
						{
							userToDowngrade.accountType = 0;
							userToDowngrade.currentChannelUserLevel = 0;
							
							var ch = findChannelByName(userToDowngrade.currentChannel);
							
							pool.getConnection(function(err,connection){
	
								if (err) {
								  connection.release();
								  console.log("database error: " + err);
								}
							   
								connection.query("update users set accountType=0 where nickname='" + userToDowngrade.nickname + "';",function(err,rows){
									connection.release();
									console.log("done autosdeop query");
								});
							});
							
							ch.sendEvent('user updated', JSON.stringify(userToDowngrade));
							
							ch.sendEvent('server message', thisCon.user.nickname + ' heeft ' + userToDowngrade.nickname + ' normaal gemaakt op kanaal ' + userToDowngrade.currentChannel + ' en blijvende rechten afgenomen.');
						}
					}
				}
				else
				{
					thisCon.con.emit('server message', 'Deze actie is niet toegestaan.');
				}
			}
			else if(commandParts[0] == "/autosop")
			{
				if(thisCon.user.accountType == 4)
				{
					var userToUpgrade = findUserFromStringName(commandParts[1]);
					
					if(userToUpgrade != null)
					{
						if((userToUpgrade.accountType != 4 && commandParts[2] == "admin") || (userToUpgrade.accountType != 3 && userToUpgrade.accountType != 4 && commandParts[2] == "cyber") || (userToUpgrade.accountType == 4 && userToUpgrade.nickname == thisCon.user.nickname))
						{	
							userToUpgrade.accountType = convertUserLevelStringToInt(commandParts[2]);
							userToUpgrade.currentChannelUserLevel = convertUserLevelStringToInt(commandParts[2]);
							
							var ch = findChannelByName(userToUpgrade.currentChannel);
							
							pool.getConnection(function(err,connection){
	
								if (err) {
								  connection.release();
								  console.log("database error: " + err);
								}
							
								connection.query("update users set accountType=" + convertUserLevelStringToInt(commandParts[2]) + " where nickname='" + userToUpgrade.nickname + "';",function(err,rows){
									connection.release();
									console.log("done autoop query");
								});
							});
							
							ch.sendEvent('user updated', JSON.stringify(userToUpgrade));
							
							ch.sendEvent('server message', thisCon.user.nickname + ' heeft ' + userToUpgrade.nickname + ' ' + commandParts[2] );
						}
					}
				}
				else
				{
					thisCon.con.emit('server message', 'Deze actie is niet toegestaan.');
				}
			}
			else if(commandParts[0] == "/autoop")
			{
				if(thisCon.user.currentChannelUserLevel == 5 || thisCon.user.currentChannelUserLevel == 4 || thisCon.user.currentChannelUserLevel == 3 || thisCon.user.currentChannelUserLevel == 2) //creator, admin, cyber, super only
				{
					var userToUpgrade = findUserFromStringName(commandParts[1]);
					
					if(userToUpgrade != null)
					{
						if(compareUserLevels(thisCon.user.currentChannelUserLevel, userToUpgrade.currentChannelUserLevel) || thisCon.user.currentChannelUserLevel == 4) //ranking check
						{
							if(thisCon.user.currentChannel != userToUpgrade.currentChannel)
							{
								thisCon.con.emit('server message', 'the user you specified is not in this channel at present.');
								return;
							}
						
							if(commandParts[2] == "oper" || commandParts[2] == "super")
							{
								userToUpgrade.currentChannelUserLevel = convertUserLevelStringToInt(commandParts[2]);
								userToUpgrade.userWhoGave = thisCon.user.nickname;
								
								var ch = findChannelByName(userToUpgrade.currentChannel);
								
								pool.getConnection(function(err,connection){
	
									if (err) {
									  connection.release();
									  console.log("database error: " + err);
									}
								
									connection.query("delete from channelrights where channelName='" + thisCon.user.currentChannel + "' AND nickname='" + userToUpgrade.nickname + "';",function(err,rows){
										connection.release();
										
										executeSimpleQuery("insert into channelrights values('" + thisCon.user.currentChannel + "', '" + userToUpgrade.nickname + "', '" + thisCon.user.nickname + "', " + convertUserLevelStringToInt(commandParts[2]) + ");");
										
									});
								});
								
								if(commandParts[2] == "super")
								{
									ch.permSuperAdmins.push({nickname: userToUpgrade.nickname, givenBy: thisCon.user.nickname});
								}
								else if(commandParts[2] == "oper")
								{
									ch.permOperators.push({nickname: userToUpgrade.nickname, givenBy: thisCon.user.nickname});
								}
								
								ch.sendEvent('user updated', JSON.stringify(userToUpgrade));
								
								ch.sendEvent('server message', thisCon.user.nickname + ' heeft ' + userToUpgrade.nickname + " blijvende " + commandParts[2] + " rechten gegeven op kanaal  " + ch.name);
							}
						}
						else
						{
							thisCon.con.emit('server message', 'Permission Denied.');
						}
					}
				}
				else
				{
					thisCon.con.emit('server message', 'Permission Denied.');
				}
			}
			else if(commandParts[0] == "/autodeop")
			{
				if(thisCon.user.currentChannelUserLevel == 5 || thisCon.user.currentChannelUserLevel == 4 || thisCon.user.currentChannelUserLevel == 3 || thisCon.user.currentChannelUserLevel == 2) //creator, admin, cyber, super only
				{
					//do the query first in case the user isn't logged in etc.
					executeSimpleQuery("delete from channelrights where channelName='" + thisCon.user.currentChannel + "' and nickname='" + commandParts[1] + "';");
					
					var userToDowngrade = findUserFromStringName(commandParts[1]);
					
					if(userToDowngrade != null)
					{
						if(compareUserLevels(thisCon.user.currentChannelUserLevel, userToDowngrade.currentChannelUserLevel) || thisCon.user.currentChannelUserLevel == 4) //ranking check
						{
							var ch = findChannelByName(thisCon.user.currentChannel);
							
							ch.loadPermissionsFromDatabase();
						
							if(thisCon.user.currentChannel == userToDowngrade.currentChannel)
							{
								userToDowngrade.currentChannelUserLevel = 0;
								
								ch.sendEvent('user updated', JSON.stringify(userToDowngrade));
							}
							
							ch.sendEvent('server message', thisCon.user.nickname + ' heeft ' + commandParts[1] + " gemaakt op kanaal " + ch.name + " en blijvende rechten afgenomen.");
						}
						else
						{
							thisCon.con.emit('server message', 'Deze actie is niet toegestaan.');
						}
					}
				}
				else
				{
					thisCon.con.emit('server message', 'Deze actie is niet toegestaan.');
				}
			}
			else if(commandParts[0] == "/autosoplist")
			{
				var list = "autosops list: ";
				
				if(thisCon.user.accountType == 4 || thisCon.user.accountType == 3)
				{
					simpleQueryCallBack("select * from users where accountType=3 or accountType=4", function(qrows)
					{
						for(var qindex=0; qindex<qrows.length; qindex++)
						{
							list += "<br />" + qrows[qindex].nickname + " heeft blijvende " + convertUserLevelIntToString(qrows[qindex].accountType) + " - rechten gegeven door " + qrows[qindex].rightsBy;
						}
						
						thisCon.con.emit('server message', list);
					});
				}

			}
			else if(commandParts[0] == "/kill")
			{
				if(thisCon.user.accountType == 4 || thisCon.user.accountType == 3)
				{
					//kill the room!
					
					var roomToKill = thisCon.user.currentChannel;
					
					if(commandParts.length == 2)
					{
						var roomToKillT = findChannelByName(commandParts[1]);
						
						if(roomToKillT == null)
						{
							thisCon.con.emit('server message', 'Kanaal niet gevonden, of bestaat niet.');
							return;
						}
						
						roomToKill = roomToKillT.name;
					}
					
					if(roomToKill == "Kletshoek")

					{
						thisCon.con.emit('server message', 'Kan door de server gemaakte kanaal niet sluiten');
						return;
					}
					if(roomToKill == "Hulp")

					{
						thisCon.con.emit('server message', 'Kan door de server gemaakte kanaal niet sluiten');
						return;
					}

					
					var userChannel = findChannelByName(roomToKill);
					
					//move all chatters to Kletshoek first...
					for(var cIndex=0; cIndex < connections.length; cIndex++)
					{
						if(connections[cIndex] != null)
						{
							if(connections[cIndex].user != null)
							{
								if(connections[cIndex].user.currentChannel == roomToKill)
								{
									connections[cIndex].con.emit('changed channel', '');
								
									userChannel.removeFromChannel(connections[cIndex].user);
									//findChannelByName("Kletshoek").addToChannel(connections[cIndex].user);
									connections[cIndex].con.emit('server message', roomToKill + ' is gesloten door ' + thisCon.user.nickname);
								}
							}
						}
					}
					
					for(var chanIndex=0; chanIndex < channels.length; chanIndex++)
					{
						if(channels[chanIndex] != null)
						{
							if(channels[chanIndex].name == roomToKill)
							{
								channels[chanIndex] = null;
							}
						}
					}
					
					executeSimpleQuery("delete from channels where name='" + roomToKill + "';");
					
					//send new channel list to everybody
					for	(index = 0; index < connections.length; index++)
					{
						if(connections[index] != null)
						{
							if(connections[index].user != null)
							{
								connections[index].user.sendChannelList();
							}
						}
					}
				}
				else
				{
					thisCon.con.emit('server message', 'Permission Denied.');
				}
			}
			else if(commandParts[0] == "/kick")
			{
				//oper, super, cyber, admin, creator from channel
				
				if(thisCon.user.currentChannelUserLevel == 4 || thisCon.user.currentChannelUserLevel == 3 || thisCon.user.currentChannelUserLevel == 2 || thisCon.user.currentChannelUserLevel == 1 || thisCon.user.currentChannelUserLevel == 5)
				{
					var userToKick = findUserFromStringName(commandParts[1]);
					
					if(userToKick != null)
					{
						if(userToKick.accountType == 3 || userToKick.accountType == 4)
						{
							thisCon.con.emit('server message', 'Deze actie is niet toegestaan.');
							return;
						}
					
						if((compareUserLevels(thisCon.user.currentChannelUserLevel, userToKick.currentChannelUserLevel) && userToKick.nickname != findChannelByName(userToKick.currentChannel).creator) || thisCon.user.currentChannelUserLevel == 4)
						{
							if(userToKick.currentChannel == thisCon.user.currentChannel)
							{
								findConnectionFromUser(userToKick).con.emit('changed channel', '');
								
								findChannelByName(userToKick.currentChannel).removeFromChannel(userToKick);
								
								//findChannelByName("Kletshoek").addToChannel(userToKick);
								
								findChannelByName(thisCon.user.currentChannel).sendEvent('server message', thisCon.user.nickname + ' heeft ' + userToKick.nickname + ' verwijdert uit kanaal ' + thisCon.user.currentChannel);

								sendChannelNumbersToAll();
							}
						}
						else
						{
							thisCon.con.emit('server message', 'Deze actie is niet toegestaan.');
						}
					}
				}
				else
				{
					thisCon.con.emit('server message', 'Deze actie is niet toegestaan.');
				}
			}
			else if(commandParts[0] == "/ban")
			{
				if(thisCon.user != null)
				{
					if(thisCon.user.currentChannelUserLevel == 4 || thisCon.user.currentChannelUserLevel == 3 || (thisCon.user.currentChannelUserLevel == 2 || thisCon.user.currentChannelUserLevel == 1 || thisCon.user.currentChannelUserLevel == 5) && findChannelByName(thisCon.user.currentChannel).creator != commandParts[1])
					{
						var userToBan = findUserFromStringName(commandParts[1]);
						
						if(userToBan != null)
						{
							if(compareUserLevels(thisCon.user.currentChannelUserLevel, userToBan.currentChannelUserLevel) || thisCon.user.currentChannelUserLevel == 4)
							{
								if(userToBan.accountType == 3 || userToBan.accountType == 4)
								{
									thisCon.con.emit('server message', 'Can not ban cyber/admin accounts.');
									return;
								}
								
								var chanToBanFrom = findChannelByName(thisCon.user.currentChannel);
							
								simpleQueryCallBack("select * from channelbans where channelName='" + thisCon.user.currentChannel + "' and nickname='" + userToBan.nickname + "'", function(rows)
								{
									if(rows.length != 0)
									{
										thisCon.con.emit('server message', 'That user is already banned');
									}
									else
									{
										executeSimpleQuery("insert into channelbans values('" + chanToBanFrom.name + "', '" + userToBan.nickname + "', '" + thisCon.user.nickname + "')");
										
										chanToBanFrom.banList.push({nickname: userToBan.nickname, bannedBy: thisCon.user.nickname});
										
										if(userToBan.currentChannel == chanToBanFrom.name)
										{
											//if the user is in the channel at present, then kick 'em
											
											findConnectionFromUser(userToBan).con.emit('changed channel', '');
								
											findChannelByName(userToBan.currentChannel).removeFromChannel(userToBan);
											
											//findChannelByName(thisCon.user.currentChannel).sendEvent('server message', thisCon.user.nickname + ' heeft ' + userToBan.nickname + ' verbannen van kanaal ' + thisCon.user.currentChannel);

											sendChannelNumbersToAll();
										}
										
										chanToBanFrom.sendEvent('server message', thisCon.user.nickname + ' heeft ' + userToBan.nickname + ' verbannen van kanaal ' + chanToBanFrom.name);
									}
								});
							}
							else
							{
								thisCon.con.emit('server message', 'Deze actie is niet toegestaan.');
							}
						}
						else
						{
							thisCon.con.emit('server message', 'Kan niet bannen van Kletshoek');
						}
					}
					else
					{
						thisCon.con.emit('server message', 'Deze actie is niet toegestaan.');
					}
				}
			}
			else if(commandParts[0] == "/unban")
			{
				if(thisCon.user != null)
				{
					if(thisCon.user.currentChannelUserLevel == 4 || thisCon.user.currentChannelUserLevel == 3 || thisCon.user.currentChannelUserLevel == 2 || thisCon.user.currentChannelUserLevel == 1 || thisCon.user.currentChannelUserLevel == 5)
					{
						var userToUnBan = findUserFromStringName(commandParts[1]);
						
						if(userToUnBan != null)
						{
							var chanToUnBanFrom = findChannelByName(thisCon.user.currentChannel);
						
							simpleQueryCallBack("select * from channelbans where channelName='" + thisCon.user.currentChannel + "' and nickname='" + userToUnBan.nickname + "'", function(rows)
							{
								if(rows.length == 0)
								{
									thisCon.con.emit('server message', 'Gebruiker is niet verbannen!');
								}
								else
								{
									executeSimpleQuery("delete from channelbans where channelName='" + thisCon.user.currentChannel + "' and nickname='" + userToUnBan.nickname + "'");
									
									for(var banIndex=0; banIndex<chanToUnBanFrom.banList.length; banIndex++)
									{
										if(chanToUnBanFrom.banList[banIndex] != null)
										{
											if(chanToUnBanFrom.banList[banIndex].nickname == userToUnBan.nickname)
											{
												chanToUnBanFrom.banList[banIndex] = null;
											}
										}
									}
									
									//let the user know they've been unbanned
									findConnectionFromUser(userToUnBan).con.emit('server message', thisCon.user.nickname + ' unbanned ' + userToUnBan.nickname + ' from ' + chanToUnBanFrom.name);
									
									chanToUnBanFrom.sendEvent('server message', thisCon.user.nickname + ' heeft ' + userToUnBan.nickname + ' toegang gegeven op kanaal ' + chanToUnBanFrom.name);
								}
							});
						}
						else
						{
							thisCon.con.emit('server message', 'Gebruiker niet online');
						}
					}
					else
					{
						thisCon.con.emit('server message', 'Deze actie is niet toegestaan.');
					}
				}
			}
			else if(commandParts[0] == "/banlist")
			{
				if(thisCon.user != null)
				{
					if(thisCon.user.currentChannelUserLevel == 4 || thisCon.user.currentChannelUserLevel == 3 || thisCon.user.currentChannelUserLevel == 2 || thisCon.user.currentChannelUserLevel == 1 || thisCon.user.currentChannelUserLevel == 5)
					{
						var currentC = findChannelByName(thisCon.user.currentChannel);
						var mess = 'Ban List for : ' + currentC.name;
						
						for(var banIndex=0; banIndex<currentC.banList.length; banIndex++)
						{
							if(currentC.banList[banIndex] != null)
							{
								mess = mess + '<br />' + currentC.banList[banIndex].nickname + ' verbannen door ' + currentC.banList[banIndex].bannedBy;
							}
						}
					
						thisCon.con.emit('server message', mess);
					}
					else
					{
						thisCon.con.emit('server message', 'Deze actie is niet toegestaan.');
					}
				}
			}
			else if(commandParts[0] == "/quit")
			{
				socket.disconnect();
			}
			else if(commandParts[0] == "/skick")
			{
				if(thisCon.user.accountType == 4 || thisCon.user.accountType == 3) //only admin/cyber user
				{
					var userToKick = findUserFromStringName(commandParts[1]);
					
					if(userToKick != null)
					{
						if(userToKick.accountType >= userToKick.accountType)
						{
							sendEventToAllLoggedInUsers('server message', thisCon.user.nickname + ' heeft ' + userToKick.nickname + ' verwijdert van de chat server.');
							
							findConnectionFromUser(userToKick).con.disconnect();
						}
					}
				}
				else
				{
					thisCon.con.emit('server message', 'Deze actie is niet toegestaan.');
				}
			}
			else if(commandParts[0] == "/sban")
			{
				if(thisCon.user.accountType == 4 || thisCon.user.accountType == 3) //only admin/cyber user
				{
					var userToBan = findUserFromStringName(commandParts[1]);
					
					if(userToBan != null)
					{
						if(thisCon.user.accountType >= userToBan.accountType)
						{
							var forTime = "72h";
						
							if(commandParts.length == 3)
							{
						
								forTime = commandParts[2];
							
							}
							
							var forSymbol = 'hour';
							
							if(forTime[forTime.length - 1] == 'm') { forSymbol = 'minute' };
							
							var banUntil = dateAdd(Date.now(), forSymbol, parseInt(forTime.substring(0, forTime.length - 1)));
							
							executeSimpleQuery("insert into serverbans values('" + userToBan.nickname + "', '" + thisCon.user.nickname + "', " + Number(banUntil) + ", '" + userToBan.ip + "')");
							
							sendEventToAllLoggedInUsers('server message', thisCon.user.nickname + ' heeft ' + userToBan.nickname + ' uitgesloten van de chat server tot ' + banUntil.toString());
							
							findConnectionFromUser(userToBan).con.disconnect();
						}
					}
					else
					{
						thisCon.con.emit('server message', 'Gebruiker niet online.');
					}
				}
				else
				{
					thisCon.con.emit('server message', 'Deze actie is niet toegestaan.');
				}
			}
			else if(commandParts[0] == "/sbanlist")
			{
				if(thisCon.user.accountType == 4 || thisCon.user.accountType == 3) //only admin/cyber user
				{	
					simpleQueryCallBack("select * from serverbans;", function(sRows)
					{
						var list = "Server Ban List:";
						
						for(var sIndex=0; sIndex < sRows.length; sIndex++)
						{
							list += "<br />" + sRows[sIndex].nickname + " is uitgesloten door " + sRows[sIndex].bannedBy + " tot " + (new Date(sRows[sIndex].unbanTimestamp)).toString();
						}
						
						thisCon.con.emit('server message', list);
					});
				}
				else
				{
					thisCon.con.emit('server message', 'Permission Denied.');
				}
			}
			else if(commandParts[0] == "/sunban")
			{
				if(thisCon.user.accountType == 4 || thisCon.user.accountType == 3) //only admin/cyber user
				{
					simpleQueryCallBack("select * from serverbans where nickname='" + commandParts[1] + "'", function(bRows)
					{
						if(bRows.length != 0)
						{
							executeSimpleQuery("delete from serverbans where nickname='" + commandParts[1] + "'");
							thisCon.con.emit('server message', 'Gebruiker heeft weer toegang tot de chat server ' + commandParts[1]);
						}
						else
						{
							thisCon.con.emit('server message', 'Gebruiker is niet uitgesloten van de chat server');
						}
					});
				}
				else
				{
					thisCon.con.emit('server message', 'Deze actie is niet toegestaan.');
				}
			}
			else if(commandParts[0] == "/version")
			{
				thisCon.con.emit('server message', "Current version is: " + version);
			}
			else if(commandParts[0] == "/info")
			{
				thisCon.con.emit('server message', "Chat Server owned by: Sunto<br />Coded By: joehollo");
			}
			else if(commandParts[0] == "/join")
			{
				if(commandParts.length == 2)
				{
					var chan = findChannelByName(commandParts[1]);
					
					if(chan == null)
					{
						if(commandParts[1].length < 3)
						{
							thisCon.con.emit('server message', 'The channel name must be 3 or more characters in length.');
							return;
						}
						
						if(commandParts[1].indexOf(" ", 0) != -1)
						{
							thisCon.con.emit('server message', 'The channel name must not contain spaces.');
						}
					
						executeSimpleQuery("insert into channels values('" + commandParts[1] + "', '" + thisCon.user.nickname + "', '', " + 0 + ");");
					
						channels.push(new Channel(commandParts[1], thisCon.user.nickname, "", 0, "", 0));
						
						executeSimpleQuery("insert into chatlogs values('" + commandParts[1 ] + "', '')");
						
						//Update all users as to the new channelArr
						for	(index = 0; index < connections.length; index++)
						{
							if(connections[index] != null)
							{
								if(connections[index].user != null)
								{
									connections[index].user.sendChannelList();
								}
							}
						}
						
						chan = findChannelByName(commandParts[1]);
					}

					thisCon.con.emit('changed channel', chan.name);
					
					if(thisCon.user.currentChannel != null)
					{
						findChannelByName(thisCon.user.currentChannel).removeFromChannel(thisCon.user);
					}
					findChannelByName(chan.name).addToChannel(thisCon.user);
				}
				else
				{
					thisCon.con.emit('server message', 'Format is: /join channelname');
				}
			}
			else if(commandParts[0] == "/topic")
			{
				if(thisCon.user != null)
				{
					if(thisCon.user.currentChannelUserLevel == 4 || thisCon.user.currentChannelUserLevel == 3 || thisCon.user.currentChannelUserLevel == 2 || thisCon.user.currentChannelUserLevel == 1 || thisCon.user.currentChannelUserLevel == 5)
					{
						var thisCh = findChannelByName(thisCon.user.currentChannel);
						
						var parsedTopic = "";
						var topicParts = msg.replace("/topic ", "").split(" ");
						
						var firstCol = true;
						
						for(var partsIndex=0; partsIndex<topicParts.length; partsIndex++)
						{
							if(/(^#[0-9A-F]{6}$)|(^#[0-9A-F]{3}$)/i.test(topicParts[partsIndex]))
							{
								if(firstCol == true)
								{
									firstCol = false;
								}
								else
								{
									parsedTopic += "</span>";
								}
								
								parsedTopic += "<span style=\"color: " + topicParts[partsIndex] + "\">";
							}
							else
							{
								parsedTopic += " " + topicParts[partsIndex];
							}
						}
						
						if(firstCol == false)
						{
							parsedTopic += "</span>";
						}
						
						thisCh.topic = parsedTopic;
						
						thisCh.sendEvent('channel topic update', thisCh.topic);
						thisCh.sendEvent('server message', thisCon.user.nickname + ' heeft de topic verandert');
						thisCh.sendEvent('server message', 'Nieuw Topic: ' + thisCh.topic);
					}
					else
					{
						thisCon.con.emit('server message', 'Deze actie is niet toegestaan.');
					}
				}
			}
			else if(commandParts[0] == "/list")
			{
				var list = "Channels are:";
				for(var listIndex=0; listIndex<channels.length; listIndex++)
				{
					if(channels[listIndex] != null)
					{
						if(channels[listIndex].type == 0 || (channels[listIndex].type == 1 && (thisCon.user.accountType == 4 || thisCon.user.accountType == 3)))
						{
							list += "<br />" + channels[listIndex].name;
						}
					}
				}
				
				thisCon.con.emit('server message', list);
			}
			else if(commandParts[0] == '/hide')
			{
				if(thisCon.user.accountType == 4 || thisCon.user.accountType == 3) //only admin/cyber user
				{
					if(thisCon.user.xcdrvesl == false)
					{
						var ch = findChannelByName(thisCon.user.currentChannel);
						
						ch.sendEvent('user left channel', thisCon.user.nickname);
						thisCon.user.xcdrvesl = true;
						ch.currentUsers--;
						
						
						sendChannelNumbersToAll();
					}
				}
			}
			else if(commandParts[0] == '/unhide')
			{
				if(thisCon.user.accountType == 4 || thisCon.user.accountType == 3) //only admin/cyber user
				{
					if(thisCon.user.xcdrvesl == true)
					{
						var ch = findChannelByName(thisCon.user.currentChannel);
						ch.sendEvent('user joined channel', JSON.stringify(thisCon.user));
						thisCon.user.xcdrvesl = false;
						ch.currentUsers++;
						
						sendChannelNumbersToAll();
					}
				}
			}
			else if(commandParts[0] == '/serrorlog')
			{
				if(thisCon.user.accountType == 4)
				{
					simpleQueryCallBack("select * from errors", function(erows)
					{
						var elog = "Error Log: ";
						
						for(var c=0; c<erows.length; c++)
						{
							elog += "<br /><br />" + erows[c].timestamp + ": " + erows[c].error + "<br />" + erows[c].stacktrace;
						}
						
						socket.emit('clog', elog);
					});
				}
			}
			else if(commandParts[0] == '/clog')
			{
				if(thisCon.user.accountType == 4)
				{
					socket.emit('clog', findChannelByName(thisCon.user.currentChannel).clog);
				}
			}
			else if(commandParts[0] == '/cleanlog')
			{
				if(thisCon.user.accountType == 4)
				{
					findChannelByName(thisCon.user.currentChannel).clog = "";
					executeSimpleQuery("update chatlogs set text='' where channelName='" + thisCon.user.currentChannel + "'");
					socket.emit('server message', 'Log van kanaal geleegd');
				}
			}
			else if(commandParts[0] == '/silent')
			{
				if(thisCon.user.currentChannelUserLevel == 5 || thisCon.user.currentChannelUserLevel == 4 || thisCon.user.currentChannelUserLevel == 3 || thisCon.user.currentChannelUserLevel == 2)
				{
					var userToSilence = findUserFromStringName(commandParts[1]);
					
					if(userToSilence != null)
					{
						if(compareUserLevels(thisCon.user.currentChannelUserLevel, userToSilence.currentChannelUserLevel))
						{
							if(userToSilence.currentChannel == thisCon.user.currentChannel)
							{
								userToSilence.bhdedl = true;
								findChannelByName(userToSilence.currentChannel).sendEvent('server message', thisCon.user.nickname + ' has silent ' + userToSilence.nickname + ' on channel ' + userToSilence.currentChannel);
								findChannelByName(userToSilence.currentChannel).sendEvent('user updated', JSON.stringify(userToSilence));
							}
						}
						else
						{
							thisCon.con.emit('server message', 'Deze actie is niet toegestaan.');
						}
					}
				}
				else
				{
					thisCon.con.emit('server message', 'Deze actie is niet toegestaan.');
				}
			}
			else if(commandParts[0] == '/unsilent')
			{
				if(thisCon.user.currentChannelUserLevel == 5 || thisCon.user.currentChannelUserLevel == 4 || thisCon.user.currentChannelUserLevel == 3 || thisCon.user.currentChannelUserLevel == 2)
				{
					var userToSilence = findUserFromStringName(commandParts[1]);
					
					if(userToSilence != null)
					{
						if(userToSilence.currentChannel == thisCon.user.currentChannel)
						{
							userToSilence.bhdedl = false;
							findChannelByName(userToSilence.currentChannel).sendEvent('server message', thisCon.user.nickname + ' have unsilenced ' + userToSilence.nickname + ' on ' + userToSilence.currentChannel);
							findChannelByName(userToSilence.currentChannel).sendEvent('user updated', JSON.stringify(userToSilence));
						}
					}
				}
				else
				{
					thisCon.con.emit('server message', 'Deze actie is niet toegestaan.');
				}
			}
			else if(commandParts[0] == '/autooplist')
			{
				var list="autoop list for " + thisCon.user.currentChannel;
				
				var ch=findChannelByName(thisCon.user.currentChannel);
				
				list += "<br />" + ch.creator + " is creator";
				
				simpleQueryCallBack("select nickname, givenBy, level from channelrights where channelName='" + thisCon.user.currentChannel + "'", function(oprows)
				{
					for(var opIndex=0; opIndex<oprows.length; opIndex++)
					{
						list += "<br />" + oprows[opIndex].nickname + " - " + convertUserLevelIntToString(oprows[opIndex].level) + " rechten door " + oprows[opIndex].givenBy;
					}
					
					thisCon.con.emit('server message', list);
				});
			}
			else if(commandParts[0] == '/allusers')
			{
				if(thisCon.user.accountType == 4 || thisCon.user.accountType == 3)
				{
					var list="all online users are:";
					
					for(var conIndex=0; conIndex < connections.length; conIndex++)
					{
						if(connections[conIndex] != null)
						{
							list += "<br />" + connections[conIndex].user.nickname + " in " + connections[conIndex].user.currentChannel;
						}
					}
					
					thisCon.con.emit('server message', list);
				}
			}
			else if(commandParts[0] == '/makestatic')
			{
				if(thisCon.user.accountType == 4 || thisCon.user.accountType == 3)
				{
					findChannelByName(thisCon.user.currentChannel).staticC = true;
					executeSimpleQuery("update channels set isStatic=1 where name='" + thisCon.user.currentChannel + "'");
					thisCon.con.emit('server message', 'Made ' + thisCon.user.currentChannel + ' static.');
				}
			}
			else
			{
				thisCon.con.emit('sever message', 'Deze actie is niet toegestaan.');
			}
		}
	});
});

function convertUserLevelIntToString(uli)
{
	if(uli == 0)
	{
		return "normal";
	}
	else if(uli == 1)
	{
		return "oper";
	}
	else if(uli == 2)
	{
		return "super";
	}
	else if(uli == 3)
	{
		return "cyber";
	}
	else if(uli == 4)
	{
		return "admin";
	}
	else if(uli == 5)
	{
		return "creator";
	}
	
	return null;
}

//if one is higher than two return true
function compareUserLevels(one, two)
{
	if(one == 4 && two == 5)
	{
		return true;
	}
	else if(one == 5 && two == 4)
	{
		return false;
	}
	
	return (one > two);
}

function convertUserLevelStringToInt(uls)
{
	//from db - level: 0=normal, 1=oper, 2=superuser, 3=cyber, 4=admin, 5=creator

	if(uls == "normal")
	{
		return 0;
	}
	else if(uls == "oper")
	{
		return 1;
	}
	else if(uls == "super")
	{
		return 2;
	}
	else if(uls == "cyber")
	{
		return 3;
	}
	else if(uls == "admin")
	{
		return 4;
	}
	else if(uls == "creator")
	{
		return 5;
	}
}

//Class definitions:

//Represents a connection to the server, .user can be null if they are not yet logged in
function Connection(user, con, ip)
{
	this.user = user;
	this.con = con;
	this.ip = ip;
}

//Represents a User of the chat system
function User(nickname, accountType, age, gender, location, additionalInfo, email, profileImage, isGuest)
{
	this.nickname = nickname;
	this.accountType = accountType; //Simple int - 0 = standard user, 1 = admin
	this.age = age;
	this.gender = gender;
	this.location = location;
	this.additionalInfo = additionalInfo;
	this.email = email;
	
	this.ip = "";
	
	this.guest = isGuest;

	this.lastActive = Date.now();
	
	this.xcdrvesl = false;
	this.bhdedl = false;
	
	this.profileImage = profileImage;
	
	this.currentChannel = "";
	//from db - level: 0=normal, 1=oper, 2=superuser, 3=cyber, 4=admin, 5=creator
	this.currentChannelUserLevel = accountType;  //will be either 0 or 4 from database for user (as only admin/normal apply to entire chat.)
	this.userWhoGave = "";
	
	this.loggedIn = Date.now();
	
	//Methods
	this.kick = kick;
	this.sendPrivateMessage = sendPrivateMessage;
	this.sendChannelList = sendChannelList;
	this.sendInitialChannelUsers = sendInitialChannelUsers;
}

//Function to kick a User
function kick(reason)
{
	var usersConnection = findConnectionFromUser(this);
	usersConnection.con.emit('kicked', reason);
	usersConnection.disconnect();
}

//Function to send a private message to a User
function sendPrivateMessage(privateMessage)
{
	var usersConnection = findConnectionFromUser(this);
	usersConnection.con.emit('private message', JSON.stringify(privateMessage));
}

//Function to send the channel list to this user
function sendChannelList()
{
	var channelArr = [];
	
	for(index=0; index < channels.length; index++)
	{
		if(channels[index] != null)
		{
			//if((channels[index].type == 1 && (this.accountType == 4 || this.accountType == 3)) || (channels[index].type == 0))
			//{
				channelArr.push(channels[index]);
			//}
		}
	}
	
	findConnectionFromUser(this).con.emit('channel list', JSON.stringify(channelArr));
}

//Function to send the users in the current channel to this user
function sendInitialChannelUsers()
{
	var usersArr = [];
	
	for	(var index = 0; index < connections.length; index++)
	{
		if(connections[index] != null && connections[index].con != null)
		{
			if(connections[index].user != null)
			{
				if(connections[index].user.currentChannel == this.currentChannel)
				{
					if(connections[index].user.xcdrvesl == false)
					{
						usersArr.push(connections[index].user);
					}
				}
			}
		}
	}
	
	findConnectionFromUser(this).con.emit('channel users list', JSON.stringify(usersArr));
}

//Represents a Channel
function Channel(name, creator, topic, type, logg, statChan)
{
	this.name = name;
	this.creator = creator;
	this.topic = topic;
	this.type = type; //Simple int - 0=normal, 1=admin
	this.currentUsers = 0;
	this.staticC = statChan;
	
	//Store values for temporary admin positions
	//Stored in form of {nickname, nicknameOfUserWhoGranted}
	//this.tempSuperAdmins = [];
	//this.tempCyberStatus = [];
	//this.tempOperators = [];  //removed because of a change in how it's stored
	
	//Store values for permenant admin positions 
	this.permSuperAdmins = [];
	this.permOperators = [];
	this.banList = [];
	
	//Store chat log
	this.clog = logg;
	this.clogSaveCount = 0;
	
	//methods:
	this.sendEvent = sendEvent;
	this.sendMessage = sendMessage;
	this.addToChannel = addToChannel;
	this.removeFromChannel = removeFromChannel;
	this.loadPermissionsFromDatabase = loadPermissionsFromDatabase;
	this.loadClogFromDatabase = loadClogFromDatabase;
	this.loadBanListFromDatabase = loadBanListFromDatabase;
	this.sendServerMessage = sendServerMessage;
}

//Function to send an event to all users of a channel
function sendEvent(eventName, contents)
{
	for	(index = 0; index < connections.length; index++)
	{
		if(connections[index] != null)
		{
			if(connections[index].user != null)
			{
				if(connections[index].user.currentChannel == this.name)
				{
					connections[index].con.emit(eventName, contents);
				}
			}
		}
	}
}

//Function to send server message to this channel i.e. < message >
function sendServerMessage(message)
{
	this.sendEvent('server message', message);
}

//Function to send a message to all users of a channel
function sendMessage(messageToSend)
{	
	this.clog += "<br />" + messageToSend.sender + " : " + messageToSend.content;
	this.clogSaveCount++;
	
	if(this.clogSaveCount == 100)
	{
		//save the log to the database every 100 messages
		executeSimpleQuery("update chatlogs set text='" + this.clog + "' where channelName='" + this.name + "';");

		this.clogSaveCount = 0;
	}
	
	this.sendEvent('channel message', JSON.stringify(messageToSend));
}

//Function to call when a user joins the channel, will notify all channel users of their joining
function addToChannel(user)
{
	for(var banIndex=0; banIndex < this.banList.length; banIndex++)
	{
		if(this.banList[banIndex] != null)
		{
			if(this.banList[banIndex].nickname == user.nickname)
			{
				//don't add the user to channel				
				findConnectionFromUser(user).con.emit('changed channel', '');
				
				findConnectionFromUser(user).con.emit('server message', 'Je bent verbannen van dit kanaal.');
				
				return;
			}
		}
	}

	//Send a JSON version of the User that's joined, so that the members of the channel have all of their info
	//for the pop up box that appears when we hover over their name...
	
	if(user.xcdrvesl == false)
	{
		this.currentUsers++;
	}
	
	var foundUserPermissions = user.accountType;
	
	if(foundUserPermissions != 4 && foundUserPermissions != 3) //don't search for permissions if the user is already an admin OR cyberhost
	{	
		//from db - level: 0=normal, 1=oper, 2=superuser, 3=cyber, 4=admin, 5=creator, 5=creator
		
		/*for(var tempOperatorsIndex=0; tempOperatorsIndex<this.tempOperators.length; tempOperatorsIndex++)
		{
			if(this.tempOperators[tempOperatorsIndex].nickname == user.nickname)
			{
				foundUserPermissions = 1;
				break;
			}
		}*/
		
		for(var permOperatorsIndex=0; permOperatorsIndex<this.permOperators.length; permOperatorsIndex++)
		{
			if(this.permOperators[permOperatorsIndex] != null)
			{
				if(this.permOperators[permOperatorsIndex].nickname == user.nickname)
				{
					foundUserPermissions = 1;
					break;
				}
			}
		}
		
		/*for(var tempSuperAdminsIndex=0; tempSuperAdminsIndex<this.tempSuperAdmins.length; tempSuperAdminsIndex++)
		{
			if(this.tempSuperAdmins[tempSuperAdminsIndex].nickname == user.nickname)
			{
				foundUserPermissions = 2;
				break;
			}
		}*/
		
		for(var permSuperAdminsIndex=0; permSuperAdminsIndex<this.permSuperAdmins.length; permSuperAdminsIndex++)
		{
			if(this.permSuperAdmins[permSuperAdminsIndex] != null)
			{
				if(this.permSuperAdmins[permSuperAdminsIndex].nickname == user.nickname)
				{
					foundUserPermissions = 2;
					break;
				}
			}
		}
		
		if(this.creator == user.nickname)
		{
			foundUserPermissions = 5;
		}
	}
	
	user.currentChannel = this.name;
	user.currentChannelUserLevel = foundUserPermissions;
	
	if(user.xcdrvesl == false)
	{
		this.sendEvent('user joined channel', JSON.stringify(user));
this.sendEvent('server message', '<span style=\"font-weight: bold">' + user.nickname + ' komt kanaal (' + user.currentChannel + ') binnen</span>');	}

	
	user.sendInitialChannelUsers();
	
	sendChannelNumbersToAll();
	
	if(this.staticC == 0)
	{
		findConnectionFromUser(user).con.emit('server message', user.nickname + ' welkom op kanaal (' + user.currentChannel + ')<br />dit kanaal is aangemaakt door: ' + this.creator);
	}
	
	findConnectionFromUser(user).con.emit('server message', '<b>Kanaal Topic:</b> ' + this.topic);
}

//Function to call when a user leaves the channel, will notify all channel users they have left
function removeFromChannel(user)
{
	//Just send the User's nickname instead of a full JSON version
	
	if(user.xcdrvesl == false)
	{
		this.currentUsers--;
	}
	
	user.currentChannelUserLevel = user.accountType;
	user.currentChannel = "";
	
	user.lastActive = Date.now();
	
	if(user.xcdrvesl == false)
	{
		this.sendEvent('user left channel', user.nickname);
		this.sendEvent('server message', user.nickname + ' verlaat kanaal (' + this.name + ')');
	}
	
	if(this.currentUsers == 0)
	{
		//channel is now empty so...
		
		if(this.staticC == 0)
		{
			//kill the channel
			
			for(var chanIndex=0; chanIndex < channels.length; chanIndex++)
			{
				if(channels[chanIndex] != null)
				{
					if(channels[chanIndex].name == this.name)
					{
						channels[chanIndex] = null;
					}
				}
			}
			
			executeSimpleQuery("delete from channels where name='" + this.name + "';");
			
			//send new channel list to everybody
			for	(index = 0; index < connections.length; index++)
			{
				if(connections[index] != null)
				{
					if(connections[index].user != null)
					{
						connections[index].user.sendChannelList();
					}
				}
			}
		}
	}
	else
	{
		sendChannelNumbersToAll();
	}
}

function loadPermissionsFromDatabase()
{	
	var currentC = this;

	this.permSuperAdmins = [];
	this.permOperators = [];
	
	pool.getConnection(function(err,connection){
	
        if (err) {
          connection.release();
          console.log("database error: " + err);
        }
       
        connection.query("select * from channelrights where channelName='" + currentC.name + "';",function(err,rows){
            connection.release();
            if(!err) {
				for (var i2 = 0; i2 < rows.length; i2++)
				{
					//from db - level: 0=normal, 1=oper, 2=superuser, 3=cyber, 4=admin, 5=creator
					
					if(rows[i2].level == 1)
					{
						currentC.permOperators.push( { nickname: rows[i2].nickname, givenBy: rows[i2].givenBy } );
						console.log("perm oper on " + currentC.name + ": " + rows[i2].nickname);
					}
					else if(rows[i2].level == 2)
					{
						currentC.permSuperAdmins.push( { nickname: rows[i2].nickname, givenBy: rows[i2].givenBy } );
						console.log("perm super on " + currentC.name + ": " + rows[i2].nickname);
					}
					else if(rows[i2].level == 3)
					{
						currentC.permCyberStatus.push( { nickname: rows[i2].nickname, givenBy: rows[i2].givenBy } );
						console.log("perm cyber on " + currentC.name + ": " + rows[i2].nickname);
					}
				}
			
				channels.push(currentC);
				currentC.loadBanListFromDatabase();
				currentC.loadClogFromDatabase();
            }
        });
  });
}

function loadClogFromDatabase()
{
	var currentC = this;
	
	simpleQueryCallBack("select * from chatlogs where channelName='" + this.name + "'", function(dcRows)
	{
		currentC.clog = dcRows[0].text;
		console.log("Loaded clog for " + currentC.name);
	});
}

//Load the banlist from the database
function loadBanListFromDatabase()
{	
	var currentC = this;

	this.banList = [];
	
	pool.getConnection(function(err,connection){
	
        if (err) {
          connection.release();
          console.log("database error: " + err);
        }
       
        connection.query("select * from channelbans where channelName='" + currentC.name + "';",function(err,rows){
            connection.release();
            if(!err) {
				for (var i2 = 0; i2 < rows.length; i2++)
				{
					//from db - level: 0=normal, 1=oper, 2=superuser, 3=cyber, 4=admin, 5=creator
					
					currentC.banList.push({nickname: rows[i2].nickname, bannedBy: rows[i2].bannedBy});
					
				}
				
				console.log("finished loading " + currentC.name + " banlist from database");
				console.log("finished loading " + currentC.name + " from database");
            }
        });
  });
}

//Represents a Message
function Message(sender, colour, content, raw)
{
	this.sender = sender; //the user that sent this message - n.b. a string version of their nickname, not an actual User object.
	this.colour = colour; //hex colour for the message
	this.timestamp = getTimeString(); //the current time
	this.content = content;
	if (raw) this.raw = raw;
	else this.raw = false;
}

//Other helper functions etc.

function getTimeString()
{
    var date = new Date();

    var hour = date.getHours();
    hour = (hour < 10 ? "0" : "") + hour;

    var min  = date.getMinutes();
    min = (min < 10 ? "0" : "") + min;

    var sec  = date.getSeconds();
    sec = (sec < 10 ? "0" : "") + sec;

    var year = date.getFullYear();

    var month = date.getMonth() + 1;
    month = (month < 10 ? "0" : "") + month;

    var day  = date.getDate();
    day = (day < 10 ? "0" : "") + day;

    return hour + ":" + min + ":" + sec;
}

function findConnectionFromUser(userToFind)
{
	for	(index = 0; index < connections.length; index++)
	{
		if(connections[index] != null)
		{
			if(connections[index].user != null)
			{
				if(connections[index].user == userToFind)
				{
					return connections[index];
				}
			}
		}
	}
}

function findUserFromStringName(nickToFind)
{
	for	(index = 0; index < connections.length; index++)
	{
		if(connections[index] != null)
		{
			if(connections[index].user != null)
			{
				if(connections[index].user.nickname == nickToFind)
				{
					return connections[index].user;
				}
			}
		}
	}
	
	return null;
}

function removeConnection(con)
{
	for	(rIndex = 0; rIndex < connections.length; rIndex++)
	{
		if(connections[rIndex] != null)
		{
			if(connections[rIndex] == con)
			{
				//If the connection is held by a logged in user, then remove them from whichever room they happen to be in
				if(connections[rIndex].user != null)
				{
					if(con.user.currentChannel != "")
					{
						findChannelByName(con.user.currentChannel).removeFromChannel(con.user);
					}
				}
				connections[rIndex] = null;
			}
		}
	}
	
	sendChannelNumbersToAll();
}

function findConnectionBySocket(socket)
{
	for	(index = 0; index < connections.length; index++)
	{
		if(connections[index] != null && connections[index].con != null)
		{
			if(connections[index].con == socket)
			{
				return connections[index];
			}
		}
	} 
}

function findChannelByName(name)
{
	for	(index = 0; index < channels.length; index++)
	{
		if(channels[index] != null)
		{
			if(channels[index].name == name)
			{
				return channels[index];
			}
		}
	}
	
	return null;
}

function isUserLoggedIn(nickname) //takes a string nickname, NOT a User object
{
	for	(index = 0; index < connections.length; index++)
	{
		if(connections[index] != null && connections[index].con != null)
		{
			if(connections[index].user != null)
			{
				if(connections[index].user.nickname == nickname)
				{
					return true;
				}
			}
		}
	}
	
	return false;
}

function sendChannelNumbersToAll()
{
	var chanNumberString = "";
	
	for	(index = 0; index < channels.length; index++)
	{
		if(channels[index] != null)
		{
			chanNumberString = chanNumberString + channels[index].name + ":" + channels[index].currentUsers + "|";
		}
	}
	
	chanNumberString = chanNumberString.substring(0, chanNumberString.length - 1);
	
	sendEventToAllLoggedInUsers('channel user numbers update', chanNumberString);
}

function sendEventToAllLoggedInUsers(eventName, contents)
{
	for	(var index = 0; index < connections.length; index++)
	{
		if(connections[index] != null)
		{
			if(connections[index].user != null)
			{
				connections[index].con.emit(eventName, contents);
			}
		}
	}
}

function processMessageContent(content, callback) {
	content = content.trim();
	// detect youtube
	var regex = new RegExp(/^http(?:s)?:\/\/(?:www\.)?youtube.com\/watch\?(?=.*v=[a-zA-Z0-9-_]+)(?:\S+)?$/);

	if (regex.test(content)) {
		var youtubeInfoUrl = 'http://www.youtube.com/oembed?url=' + content + '&format=json';
		request(youtubeInfoUrl, function (error, response, body) {
			if (!error && response.statusCode == 200) {
				if (typeof callback == 'function') {
					var info = JSON.parse(body);
					
					var msg = '<a class="youtube-link" href="' + content + '" target="_blank">' + info.title + '</a>';
					
					if (typeof callback == 'function') {
						callback(msg, true);
					}
				} else {
					if (typeof callback == 'function') {
						callback(content, false);
					}
				}
			}
		});
		
	} else {
		if (typeof callback == 'function') {
			callback(content, false);
		}
	}
	
	//return validator.escape(content);
}

function sendServerMessageToAllLoggedInUsers(message)
{
	sendEventToAllLoggedInUsers('server message', message);
}

//Error Handling so server won't go down on unexpected input etc.
process.on('uncaughtException', function (err)
{
	console.log('Caught exception: ' + err);
	console.log(err.stack);
	
	executeSimpleQuery("insert into errors values('" + Date.now() + "', '" + err + "', '" + err.stack + "')");
});

function dateAdd(date, interval, units) {
  var ret = new Date(date); //don't change original date
  switch(interval.toLowerCase()) {
    case 'year'   :  ret.setFullYear(ret.getFullYear() + units);  break;
    case 'quarter':  ret.setMonth(ret.getMonth() + 3*units);  break;
    case 'month'  :  ret.setMonth(ret.getMonth() + units);  break;
    case 'week'   :  ret.setDate(ret.getDate() + 7*units);  break;
    case 'day'    :  ret.setDate(ret.getDate() + units);  break;
    case 'hour'   :  ret.setTime(ret.getTime() + units*3600000);  break;
    case 'minute' :  ret.setTime(ret.getTime() + units*60000);  break;
    case 'second' :  ret.setTime(ret.getTime() + units*1000);  break;
    default       :  ret = undefined;  break;
  }
  return ret;
}

if (!String.prototype.endsWith) {
  String.prototype.endsWith = function(searchString, position) {
      var subjectString = this.toString();
      if (position === undefined || position > subjectString.length) {
        position = subjectString.length;
      }
      position -= searchString.length;
      var lastIndex = subjectString.indexOf(searchString, position);
      return lastIndex !== -1 && lastIndex === position;
  };
}

if (!String.prototype.includes) {
  String.prototype.includes = function() {'use strict';
    return String.prototype.indexOf.apply(this, arguments) !== -1;
  };
}


