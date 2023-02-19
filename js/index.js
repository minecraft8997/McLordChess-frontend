var hasConnectedThisSession = false;
var dontShowDefaultDisconnectMessage = false;
var socket = null;
var state = null;
var engine = null;
var board = null;
var color = null;

/* ==========================================================
   Networking
   ========================================================== */

var socketUrl = "ws://localhost:5557/socket";

function processQuickStats() {
    $("#quick-stats").hide();

    var socket = new WebSocket(socketUrl);

    function onError() {
        $("#quick-stats").text("Could not retrieve quick statistics");
        $("#quick-stats").show();
        socket.close();
    }
    function onSuccess(onlinePlayerCount, roomsTotal) {
        $("#quick-stats").html("At the moment this page was loaded, there were <i>" + onlinePlayerCount + "</i> player(s) online and <i>" + roomsTotal + "</i> room(s) in total hosted by the game server");
        $("#quick-stats").show();
        socket.close();
    }

    socket.onopen = function(event) {
        socket.send("mclord_quick_stats");
    };
    socket.onmessage = function(event) {
        var splittedMessage = event.data.split(" ");
        if (splittedMessage.length !== 3) { onError(); return; }
        if (splittedMessage[0] !== "mclord_ok") { onError(); return; }

        var onlinePlayerCount = parseInt(splittedMessage[1]);
        var roomsTotal = parseInt(splittedMessage[2]); 

        if (onlinePlayerCount === NaN || roomsTotal === NaN) onError();
        else onSuccess(onlinePlayerCount, roomsTotal);
    };
    socket.onclose = function(event) {
        if ($("#quick-stats").is(":hidden")) onError();
    }
    socket.onerror = function(event) { onError(); };
}

function lockAndOpenConnection(mode, code) {
    $(".menu").css("pointer-events", "none");

    socket = new WebSocket(socketUrl);

    socket.onopen = function(event) {
        hasConnectedThisSession = true;
        $(".menu").hide();

        var initialMessage = "mclord_" + mode;
        if (mode === "connect") initialMessage += " " + code;
        socket.send(initialMessage);

        state = "connecting";
    };

    socket.onmessage = function(event) {
        var message = event.data;
        if (message.startsWith("disconnect:")) {
            dontShowDefaultDisconnectMessage = true;
            
            if (message === "disconnect:invalid_code") {
                softClose("Disconnected. Invalid invitation code");
            } else if (message === "disconnect:already_in_game") {
                softClose("Disconnected. This room is no longer accepting new players");
            } else if (message === "disconnect:protocol_error") {
                softClose("Disconnected. The server has reported a protocol error on our end");
            } else if (message === "disconnect:ooooh_i_am_giving_it_up") {
                softClose("Disconnected. The server attempted to generate an invitation code for you 5 times but each time it was not unique. Consider something strange happened today");
            } else if (message === "disconnect:opponent_disconnected") {
                softClose("Disconnected. Your opponent has disconnected (might be due to an error)")
            } else if (message === "disconnect:overloaded") {
                softClose("Disconnected. The game server is currently " +
                        "overloaded and is unable to handle your connection");
            } else if (message === "disconnect:host_timeout") {
                softClose("Disconnected. We can't allow more than 15 minutes for waiting for your opponent");
            } else if (message === "disconnect:you_won") {
                softClose("Congratulations, you have checkmated your opponent and won the game!")
            } else if (message === "disconnect:you_lost") {
                softClose("Your opponent has checkmated you. Better luck next time, we hope you have enjoyed the game <3")
            } else {
                softClose("Disconnected. The exact reason is unknown");
            }

            return;
        }
        var parts = message.split(" ");
        
        function handleOkStartingPacket() {
            if (parts.length != 2) { protocolError(); return false; }

            if (parts[0] !== "ok_starting") { protocolError(); return false; }
            if (parts[1] !== "white" && parts[1] !== "black") { protocolError(); return false; }

            color = parts[1];
            initializeCountdownTimer(color === "white" ? "me" : "opponent");

            $("#waiting-text").hide();
            $("#pgn").show(); updatePGN(); // it's safe to call the method before engine init
            state = "playing";

            initializeGame();

            return true;
        }

        if (state === "connecting") {
            if (mode === "host") {
                if (parts.length != 2) { protocolError(); return; }
    
                if (parts[0] !== "host_ok") { protocolError(); return; }
                if (!checkInvitationCode(parts[1])) { protocolError(); return; }

                $("#waiting-text").show();
                $("#waiting-text").html("The invitation code of your room is <i>" + parts[1] + "</i>. Waiting...");

                state = "host_waiting";
            } else {
                if (!handleOkStartingPacket()) return;
            }
        } else if (state === "host_waiting") {
            if (!handleOkStartingPacket()) return;
        } else if (state === "playing") {
            if (parts[0] === "san") {
                pauseTimer();
                resumeTimer("me");
                var move = engine.move(parts[1]);
                if (move === null) { protocolError(); return; }
            
                board.move(move.from + "-" + move.to);
                if (move.promotion !== undefined) { // sounds quite interesting
                    board.position(engine.fen(), true);
                }
                updatePGN();
            } else if (parts[0] === "time_sync") {
                var hostTime = parseInt(parts[1]);
                var opponentTime = parseInt(parts[2]);
                if (hostTime === NaN || opponentTime === NaN) { protocolError(); return; }

                if (mode === "host") {
                    opponentTimeTicks = opponentTime;
                    myTimeTicks = hostTime;
                } else {
                    opponentTimeTicks = hostTime;
                    myTimeTicks = opponentTime;
                }
            } else {
                protocolError();
            }
        }
    };

    socket.onclose = function(event) {
        if (timerId !== null) pauseTimer();
        if (!dontShowDefaultDisconnectMessage) {
            scheduleAlert("Disconnected. We didn't receive a valid disconnection packet");
        }
        if (board !== null) {
            updatePGN();
            $("#quit-button").show();
        } else {
            restoreMenu();
        }
    };

    socket.onerror = function(event) {
        if (!hasConnectedThisSession) {
            scheduleAlert("We've failed to connect to the game server, sorry!");
        } else {
            scheduleAlert("An error occurred, sorry!");
        }
        dontShowDefaultDisconnectMessage = true;
    }
}

function checkSocketDeath() {
    return (
        socket === null ||
        socket.readyState === WebSocket.CLOSING ||
        socket.readyState === WebSocket.CLOSED
    );
}

/* ==========================================================
   Game
   ========================================================== */

var squareHighlightColorOne = "#82ff0d";
var squareHighlightColorTwo = "#67c211";

function isItMyTurn() {
    var currentColor = (engine.turn() === 'w' ? "white" : "black");

    return color === currentColor;
}

function highlightSquare(square) {
    var squareElement = $("#board .square-" + square);

    if (squareElement.hasClass("black-3c85d")) {
        squareElement.css('background', squareHighlightColorTwo);
    } else {
        squareElement.css('background', squareHighlightColorOne);
    }
}

function terminateHighlighting() {
    $("#board .square-55d63").css('background', '');
}

function initializeGame() {
    engine = new Chess();
    board = Chessboard("board", {
        draggable: true,
        orientation: color,
        onDragStart: function(source, piece, position, orientation) {
            if (checkSocketDeath()) return false;
            if (engine.game_over()) return false;
            if (!isItMyTurn()) return false;
            if (color === "white") {
                if (piece.search(/^b/) !== -1) return false;
            } else {
                if (piece.search(/^w/) !== -1) return false;
            }

            return true;
        },
        onDrop: function(source, target) {
            terminateHighlighting();
            var move = engine.move({ from: source, to: target, promotion: 'q' });
            if (move === null) return 'snapback';

            socket.send("san " + move.san);
            pauseTimer();
            updatePGN();
            resumeTimer("opponent");
        },
        onSnapEnd: function() {
            board.position(engine.fen(), true);
        },
        onMouseoverSquare: function(square, piece) {
            if (checkSocketDeath()) return false;
            if (!isItMyTurn()) return;

            var legalMoves = engine.moves({ square: square, verbose: true });
            if (legalMoves.length === 0) return;

            highlightSquare(square);
            for (var i = 0; i < legalMoves.length; i++) {
                highlightSquare(legalMoves[i].to);
            }
        },
        onMouseoutSquare: function(square, piece) {
            terminateHighlighting();
        }
    });

    board.start();
    $("#board").show();
}

function disposeGame() {
    $("#board").hide();
    engine = null;
    board = null;
    color = null;
}

/* ==========================================================
   Countdown Timer
   ========================================================== */

var playerTimeTicks = 36000; // = 1800s * 20ticks/s

var timerId = null;
var opponentTimeTicks = null;
var myTimeTicks = null;

function initializeCountdownTimer(who) {
    opponentTimeTicks = playerTimeTicks;
    myTimeTicks = playerTimeTicks;

    $("#countdown-timer").show();
    $("#opponent-timer").text(ticksToReadableTime(opponentTimeTicks));
    $("#my-timer").text(ticksToReadableTime(myTimeTicks));

    resumeTimer(who);
}

function resumeTimer(who) {
    timerId = setInterval(() => {
        var remaining = null;
        var elementWho = null;
        if (who === "opponent") {
            remaining = --opponentTimeTicks;
            elementWho = "opponent";
        } else {
            remaining = --myTimeTicks;
            elementWho = "my";
        }
        /*if (remaining % 20 == 0)*/ $("#" + elementWho + "-timer").text(ticksToReadableTime(remaining));

        if (remaining <= 0) clearInterval(timerId);
    }, 50); // 20ticks/s => should be called every 1000/20=50ms
}

function pauseTimer() {
    clearInterval(timerId);
}

function ticksToReadableTime(ticksLeft) {
    if (ticksLeft < 0) ticksLeft = 0;

    var seconds = ~~(ticksLeft / 20);
    var minutes = ~~(seconds / 60);
    seconds -= minutes * 60;

    minutes = "" + minutes; seconds = "" + seconds;
    if (minutes.length === 1) minutes = "0" + minutes;
    if (seconds.length === 1) seconds = "0" + seconds;

    return minutes + ":" + seconds;
}

function disposeTimer() {
    if (timerId !== null) pauseTimer();

    timerId = null;
    opponentTimeTicks = null;
    myTimeTicks = null;

    $("#opponent-timer").text("");
    $("#my-timer").text("");
    $("#countdown-timer").hide();
}

/* ==========================================================
   Utilities
   ========================================================== */

function updatePGN() {
    var pgn = (engine !== null ? engine.pgn() : null);
    //console.log(pgn.length);
    $("#pgn").html("<b>PGN:</b> " + (pgn === null || pgn.length === 0 ? "<not presented>" : pgn));
}

function scheduleAlert(message) {
    setTimeout(() => alert(message), 50);
}

function softClose(alertMessage) {
    dontShowDefaultDisconnectMessage = true;
    socket.close();

    scheduleAlert(alertMessage);
}

function protocolError() {
    softClose("Disconnected due to a protocol error");
}

function restoreMenu() {
    $("#waiting-text").hide();
    $("#pgn").hide();
    $("#quit-button").hide();
   
    hasConnectedThisSession = false;
    dontShowDefaultDisconnectMessage = false;
    socket = null;
    state = null;
    disposeGame();

    $(".menu").css("pointer-events", "auto");
    $(".menu").show();
    $("#join-room").text("Join the game room!");
    $("#host-room").text("Host your own room!");
}

function checkInvitationCode(code) {
    if (code.length != 4) return false;

    for (var i = 0; i < code.length; i++) {
        var currentChar = code.charAt(i);
        if (currentChar >= 'a' && currentChar <= 'f') continue;
        if (currentChar >= '0' && currentChar <= '9') continue;

        return false;
    }

    return true;
}

/* ==========================================================
   Entry point
   ========================================================== */

var copyright = $(".copyright-notice");
var copyrightText = copyright.text();
var currentYear = (new Date()).getFullYear();

if (copyrightText !== "© deewend, " + currentYear) {
    copyright.text(copyrightText + "-" + currentYear);
}

$("#join-room").click(function () {
    var code = $("#invitation-code").val();
    if (!checkInvitationCode(code)) {
        alert("Invalid invitation code");

        return;
    }

    lockAndOpenConnection("connect", code);
    $("#join-room").text("Joining...");
});

$("#host-room").click(function() {
    lockAndOpenConnection("host", null);
    $("#host-room").text("Waiting for a response...");
});

$("#quit-button").click(function() {
    restoreMenu();
});

processQuickStats();
