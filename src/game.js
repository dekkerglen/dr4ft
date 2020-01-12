const crypto = require("crypto");
const Bot = require("./bot");
const Human = require("./human");
const Pool = require("./pool");
const Room = require("./room");
const Rooms = require("./rooms");
const logger = require("./logger");
const uuid = require("uuid");
const Sock = require("./sock");
const {shuffle, uniqueId} = require("lodash");
const fs = require("fs");
const jsonfile = require("jsonfile");

const SECOND = 1000;
const MINUTE = 1000 * 60;
const HOUR = 1000 * 60 * 60;

const games = {};

(function playerTimer() {
  Object.values(games)
    .forEach(({round, players}) => {
      if (round < 1) {
        return;
      }
      players.forEach((player) => {
        if (player.time && !--player.time)
          player.pickOnTimeout();
      });
    });
  setTimeout(playerTimer, SECOND);
})();

(function gameTimer() {
  const now = Date.now();
  Object.values(games)
    .forEach(({expires, kill}) => {
      if (expires < now)
        kill("game over");
    });

  setTimeout(gameTimer, MINUTE);
})();

module.exports = class Game extends Room {
  constructor({ hostId, title, seats, type, sets, cube, isPrivate, modernOnly, totalChaos, chaosPacksNumber }) {
    super({ isPrivate });
    const gameID = uniqueId();
    Object.assign(this, {
      title, seats, type, isPrivate, modernOnly, totalChaos, cube, chaosPacksNumber,
      delta: -1,
      hostID: hostId,
      id: gameID,
      players: [],
      round: 0,
      bots: 0,
      sets: sets || [],
      secret: uuid.v4()
    });

    // Handle packsInfos to show various informations about the game
    switch(type) {
    case "draft":
    case "sealed":
      this.packsInfo = this.sets.join(" / ");
      this.rounds = this.sets.length;
      break;
    case "cube draft":
      this.packsInfo = `${cube.packs} packs with ${cube.cards} cards from a pool of ${cube.list.length} cards`;
      this.rounds = this.cube.packs;
      break;
    case "cube sealed":
      this.packsInfo = `${cube.cubePoolSize} cards per player from a pool of ${cube.list.length} cards`;
      this.rounds = this.cube.packs;
      break;
    case "chaos draft":
    case "chaos sealed": {
      const chaosOptions = [];
      chaosOptions.push(`${this.chaosPacksNumber} Packs`);
      chaosOptions.push(modernOnly ? "Modern sets only" : "Not modern sets only");
      chaosOptions.push(totalChaos ? "Total Chaos" : "Not Total Chaos");
      this.packsInfo = `${chaosOptions.join(", ")}`;
      this.rounds = this.chaosPacksNumber;
      break;
    }
    default:
      this.packsInfo = "";
    }

    if (cube) {
      Object.assign(this, {
        cubePoolSize: cube.cubePoolSize,
        packsNumber: cube.packs,
        playerPackSize: cube.cards
      });
    }

    this.renew();
    games[gameID] = this;

    Rooms.add(gameID, this);
    this.once("kill", () => Rooms.delete(gameID));
    Game.broadcastGameInfo();
  }

  renew() {
    this.expires = Date.now() + HOUR;
  }

  get isActive() {
    return this.players.some(x => x.isActive);
  }

  get didGameStart() {
    return this.round !== 0;
  }

  get isGameFinished() {
    return this.round === -1;
  }

  get isGameInProgress() {
    return this.didGameStart && !this.isGameFinished;
  }

  // The number of total games. This includes ones that have been long since
  // abandoned but not yet garbage-collected by the `renew` mechanism.
  static numGames() {
    return Object.keys(games).length;
  }

  // The number of games which have a player still in them.
  static numActiveGames() {
    let count = 0;
    for (let id of Object.keys(games)) {
      if (games[id].isActive)
        count++;
    }
    return count;
  }

  // The number of players in active games.
  static totalNumPlayers() {
    let count = 0;
    for (let id of Object.keys(games)) {
      if (games[id].isActive) {
        count += games[id].players.filter(x => x.isConnected && !x.isBot).length;
      }
    }
    return count;
  }

  static broadcastGameInfo() {
    Sock.broadcast("set", {
      numPlayers: Game.totalNumPlayers(),
      numGames: Game.numGames(),
      numActiveGames: Game.numActiveGames(),
    });
    Game.broadcastRoomInfo();
  }

  static broadcastRoomInfo() {
    const roomInfo =
      Object.values(games).reduce((acc, game) => {
        if (game.isPrivate || game.didGameStart || !game.isActive)
          return acc;

        const usedSeats = game.players.length;
        const totalSeats = game.seats;
        if (usedSeats === totalSeats)
          return acc;

        acc.push({
          id: game.id,
          title: game.title,
          usedSeats,
          totalSeats,
          name: game.name,
          packsInfo: game.packsInfo,
          type: game.type,
          timeCreated: game.timeCreated,
        });
        return acc;
      }, []);
    Sock.broadcast("set", { roomInfo });
  }

  name(name, sock) {
    super.name(name, sock);
    sock.h.name = sock.name;
    this.meta();
  }

  join(sock) {
    // Reattach sock to player based on his id
    this.players.some((player) => {
      if (player.id === sock.id) {
        player.attach(sock);
        this.greet(player);
        this.meta();
        super.join(sock);
        return true;
      }
    });

    if (this.didGameStart) {
      return sock.err("game already started");
    }

    super.join(sock);

    const h = new Human(sock);
    if (h.id === this.hostID) {
      h.isHost = true;
      sock.once("start", this.start.bind(this));
      sock.removeAllListeners("kick");
      sock.on("kick", this.kick.bind(this));
      sock.removeAllListeners("swap");
      sock.on("swap", this.swap.bind(this));
    }
    h.on("meta", this.meta.bind(this));
    this.players.push(h);
    this.greet(h);
    this.meta();
  }

  swap([i, j]) {
    const l = this.players.length;

    if (j < 0 || j >= l)
      return;

    [this.players[i], this.players[j]] = [this.players[j], this.players[i]];

    this.players.forEach((p, i) => p.send("set", { self: i }));
    this.meta();
  }

  kick(i) {
    const h = this.players[i];
    if (!h || h.isBot)
      return;

    if (this.didGameStart)
      h.kick();
    else
      h.exit();

    h.err("you were kicked");
    h.kick();
  }

  greet(h) {
    h.isConnected = true;
    h.send("set", {
      isHost: h.isHost,
      round: this.round,
      self: this.players.indexOf(h),
      sets: this.sets
    });
    h.send("gameInfos", {
      type: this.type,
      packsInfo: this.packsInfo,
      sets: this.sets
    });

    if (this.isGameFinished) {
      h.send("log", h.draftLog.round);
    }
  }

  exit(sock) {
    super.exit(sock);
    if (this.didGameStart)
      return;

    sock.removeAllListeners("start");
    const index = this.players.indexOf(sock.h);
    this.players.splice(index, 1);

    this.players.forEach((p, i) => p.send("set", { self: i }));
    this.meta();
  }

  meta(state = {}) {
    state.players = this.players.map(p => ({
      hash: p.hash,
      name: p.name,
      time: p.time,
      packs: p.packs.length,
      isBot: p.isBot,
      isConnected: p.isConnected,
    }));
    this.players.forEach((p) => p.send("set", state));
    Game.broadcastGameInfo();
  }

  kill(msg) {
    if (!this.isGameFinished) {
      this.players.forEach(p => p.err(msg));
    }

    delete games[this.id];
    Game.broadcastGameInfo();

    this.emit("kill");
  }

  uploadDraftStats() {
    const draftStats = this.cube
      ? { list: this.cube.list }
      : { sets: this.sets };
    draftStats.id = this.id;
    draftStats.draft = {};

    this.players.forEach((p) => {
      if (!p.isBot) {
        draftStats.draft[p.id] = p.draftStats;
      }
    });

    const file = `./data/draftStats/${this.id}.json`;
    fs.writeFileSync(file, JSON.stringify(draftStats, undefined, 2));
  }

  end() {
    this.players.forEach((p) => {
      if (!p.isBot) {
        p.send("log", p.draftLog.round);
      }
    });
    const cubeHash = /cube/.test(this.type)
      ? crypto.createHash("SHA512").update(this.cube.list.join("")).digest("hex")
      : "";

    const draftcap = {
      "gameID": this.id,
      "players": this.players.length - this.bots,
      "type": this.type,
      "sets": this.sets,
      "seats": this.seats,
      "time": Date.now(),
      "cap": this.players.map((player, seat) => ({
        "id": player.id,
        "name": player.name,
        "seat": seat,
        "picks": player.cap.packs,
        "cubeHash": cubeHash
      }))
    };

    const file = "./data/cap.json";
    jsonfile.writeFile(file, draftcap, { flag: "a" }, function (err) {
      if (err) logger.error(err);
    });

    this.renew();
    this.round = -1;
    this.meta({ round: -1 });
    if (["cube draft", "draft"].includes(this.type)) {
      this.uploadDraftStats();
    }
  }

  pass(p, pack) {
    if (!pack.length) {
      if (!--this.packCount)
        this.startRound();
      else
        this.meta();
      return;
    }

    const index = this.players.indexOf(p) + this.delta;
    const nextPlayer = this.getNextPlayer(index);
    nextPlayer.getPack(pack);
    if (!nextPlayer.isBot) {
      this.meta();
    }
  }

  startRound() {
    const { players } = this;
    if (this.round != 0) {
      players.forEach((p) => {
        p.cap.packs[this.round] = p.picks;
        p.picks = [];
        if (!p.isBot) {
          p.draftLog.round[this.round] = p.draftLog.pack;
          p.draftLog.pack = [];
        }
      });
    }

    if (this.round++ === this.rounds) {
      return this.end();
    }

    this.packCount = players.length;
    this.delta *= -1;

    players.forEach((p) => {
      if (!p.isBot) {
        p.pickNumber = 0;
        const pack = this.pool.shift();
        p.getPack(pack);
        p.send("packSize", pack.length);
      }
    });

    //let the bots play
    this.meta = () => { };
    let index = players.findIndex(p => !p.isBot);
    let count = players.length;
    while (--count) {
      index -= this.delta;
      const p = this.getNextPlayer(index);
      if (p.isBot)
        p.getPack(this.pool.shift());
    }
    this.meta = Game.prototype.meta;
    this.meta({ round: this.round });
  }

  hash(h, deck) {
    h.hash = this.hash(deck);
    this.meta();
  }

  getStatus() {
    const { players, didGameStart, round } = this;
    return {
      didGameStart: didGameStart,
      currentPack: round,
      players: players.map((player, index) => ({
        playerName: player.name,
        id: player.id,
        seatNumber: index
      }))
    };
  }

  getDecks({ seat, id }) {
    if (typeof seat == "number") {
      const player = this.players[seat];
      return player.getPlayerDeck();
    }

    if (typeof id == "string") {
      const player = this.players.find(p => p.id == id);
      return player.getPlayerDeck();
    }

    return this.players.map((player) => player.getPlayerDeck());
  }


  createPool() {
    switch (this.type) {
    case "cube draft": {
      this.pool = Pool.DraftCube({
        cubeList: this.cube.list,
        playersLength: this.players.length,
        packsNumber: this.cube.packs,
        playerPackSize: this.cube.cards
      });
      break;
    }
    case "cube sealed": {
      this.pool = Pool.SealedCube({
        cubeList: this.cube.list,
        playersLength: this.players.length,
        playerPoolSize: this.cubePoolSize
      });
      break;
    }
    case "draft": {
      this.pool = Pool.DraftNormal({
        playersLength: this.players.length,
        sets: this.sets
      });
      break;
    }
    case "sealed": {
      this.pool = Pool.SealedNormal({
        playersLength: this.players.length,
        sets: this.sets
      });
      break;
    }
    case "chaos draft": {
      this.pool = Pool.DraftChaos({
        playersLength: this.players.length,
        packsNumber: this.chaosPacksNumber,
        modernOnly: this.modernOnly,
        totalChaos: this.totalChaos
      });
      break;
    }
    case "chaos sealed": {
      this.pool = Pool.SealedChaos({
        playersLength: this.players.length,
        packsNumber: this.chaosPacksNumber,
        modernOnly: this.modernOnly,
        totalChaos: this.totalChaos
      });
      break;
    }
    default: throw new Error(`Type ${this.type} not recognized`);
    }
  }

  handleSealed() {
    this.createPool();
    this.round = -1;
    this.players.forEach((p) => {
      p.pool = this.pool.shift();
      p.send("pool", p.pool);
      p.send("set", { round: -1 });
    });
  }

  handleDraft({ addBots, useTimer, timerLength, shufflePlayers }) {
    const {players} = this;

    players.forEach((p) => {
      p.useTimer = useTimer;
      p.timerLength = timerLength;
    });

    if (addBots) {
      while (players.length < this.seats) {
        players.push(new Bot());
        this.bots++;
      }
    }

    if (shufflePlayers)
      shuffle(players);

    players.forEach((p, i) => {
      p.self = i;
      p.on("pass", this.pass.bind(this, p));
      p.send("set", { self: i });
    });

    this.createPool();
    this.startRound();
  }

  start({ addBots, useTimer, timerLength, shufflePlayers }) {
    try {
      Object.assign(this, { addBots, useTimer, timerLength, shufflePlayers });
      this.renew();

      if (/sealed/.test(this.type)) {
        this.handleSealed();
      } else {
        this.handleDraft({ addBots, useTimer, timerLength, shufflePlayers });
      }

      logger.info(`Game ${this.id} started.\n${this.toString()}`);
      Game.broadcastGameInfo();
    } catch(err) {
      logger.error(`Game ${this.id}  encountered an error while starting: ${err.stack} GameState: ${this.toString()}`);
      this.players.forEach(player => {
        if (!player.isBot) {
          player.exit();
          player.err("Whoops! An error occurred while starting the game. Please try again later. If the problem persists, you can open an issue on the Github repository: <a href='https://github.com/dr4fters/dr4ft/issues'>https://github.com/dr4fters/dr4ft/issues</a>");
        }
      });
      delete games[this.id];
      Game.broadcastGameInfo();
      this.emit("kill");
    }
  }

  toString() {
    return `
    Game State
    ----------
    id: ${this.id}
    hostId: ${this.hostID}
    title: ${this.title}
    seats: ${this.seats}
    type: ${this.type}
    sets: ${this.sets}
    isPrivate: ${this.isPrivate}
    modernOnly: ${this.modernOnly}
    totalChaos: ${this.totalChaos}
    chaosPacksNumber: ${this.chaosPacksNumber}
    packsInfos: ${this.packsInfo}
    players: ${this.players.length} (${this.players.filter(pl => !pl.isBot).map(pl => pl.name).join(", ")})
    bots: ${this.bots}
    ${this.cube ?
    `cubePoolSize: ${this.cube.cubePoolSize}
    packsNumber: ${this.cube.packs}
    playerPackSize: ${this.cube.cards}
    cube: ${this.cube.list}`
    : ""}`;
  }

  getNextPlayer(index) {
    const {length} = this.players;
    return this.players[(index % length + length) % length];
  }
};
