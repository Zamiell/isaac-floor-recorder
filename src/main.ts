import {
  getRooms,
  getStage,
  getStageType,
  getStartSeedString,
  goToStage,
  jsonEncode,
  onSetSeed,
} from "isaacscript-common";
import { RoomData } from "./types/RoomData";

/** Indexed by grid index (stringified to prevent errors with JSON encoding). */
type RoomsMap = LuaTable<string, RoomData>;

/** Indexed by the string `${stage}${stageType}`. */
type FloorsMap = LuaTable<string, RoomsMap>;

/** Indexed by seed. */
type SeedsMap = LuaTable<string, FloorsMap>;

const MOD_NAME = "isaac-floor-recorder";
const FINAL_STAGE = LevelStage.STAGE8;
const VERBOSE = true;
const NUMBER_OF_SEEDS_BEFORE_WRITING_TO_DISK = 100;

const STAGES_TO_SKIP = new Set([
  9, // Blue Womb
  13, // Home
]);

// Variables
let mod: Mod | null = null;
let currentStartSeedString: string | null = null;
let restart = false;
let recordingStage = LevelStage.STAGE1_1;
let recordingStageType = StageType.STAGETYPE_ORIGINAL;
let floorsMap: FloorsMap = new LuaTable();
const seedsMap: SeedsMap = new LuaTable();
let seedsMapSize = 0;

export function main(): void {
  mod = RegisterMod(MOD_NAME, 1);

  mod.AddCallback(ModCallbacks.MC_POST_RENDER, postRender); // 2
  mod.AddCallback(ModCallbacks.MC_POST_GAME_STARTED, postGameStarted); // 15
  mod.AddCallback(ModCallbacks.MC_POST_NEW_LEVEL, postNewLevel); // 18
}

// ModCallbacks.MC_POST_RENDER (2)
function postRender() {
  if (restart) {
    restart = false;
    Isaac.ExecuteCommand("restart");
  }
}

// ModCallbacks.MC_POST_GAME_STARTED (15)
function postGameStarted(continued: boolean) {
  if (VERBOSE) {
    Isaac.DebugString(`MC_POST_GAME_STARTED - ${getStartSeedString()}`);
  }

  if (!validateRun(continued)) {
    return;
  }

  floorsMap = new LuaTable();
  goToStage(recordingStage, recordingStageType);
}

function validateRun(continued: boolean) {
  const game = Game();
  const seeds = game.GetSeeds();
  const challenge = Isaac.GetChallenge();
  const player = Isaac.GetPlayer();
  const character = player.GetPlayerType();

  if (continued) {
    error(`The ${MOD_NAME} mod will not work when continuing a run.`);
  }

  if (onSetSeed()) {
    error(`The ${MOD_NAME} mod will not work on set seeds.`);
  }

  if (game.Difficulty !== Difficulty.DIFFICULTY_NORMAL) {
    error(`The ${MOD_NAME} mod will not work on non-normal difficulties.`);
  }

  if (challenge !== Challenge.CHALLENGE_NULL) {
    error(`The ${MOD_NAME} mod will not work on challenges.`);
  }

  if (character !== PlayerType.PLAYER_ISAAC) {
    error(`The ${MOD_NAME} mod will not work on characters other than Isaac.`);
  }

  if (!seeds.HasSeedEffect(SeedEffect.SEED_PREVENT_ALL_CURSES)) {
    seeds.AddSeedEffect(SeedEffect.SEED_PREVENT_ALL_CURSES);
    restartOnNextFrame();
    Isaac.DebugString("Disabling curses and restarting the run.");
    return false;
  }

  return true;
}

// ModCallbacks.MC_POST_NEW_LEVEL (18)
function postNewLevel() {
  if (VERBOSE) {
    Isaac.DebugString(`MC_POST_NEW_LEVEL - ${getStage()}.${getStageType()}`);
  }

  const startSeedString = getStartSeedString();

  // Don't do anything upon getting to the first level,
  // since we are on a randomly selected stage type
  if (startSeedString !== currentStartSeedString) {
    currentStartSeedString = startSeedString;
    return;
  }

  recordFloor();
  moveToNextFloor();
}

function recordFloor() {
  const roomsMap: RoomsMap = new LuaTable();

  for (const roomDesc of getRooms()) {
    const data = roomDesc.Data;
    if (data === undefined) {
      continue;
    }

    roomsMap.set(tostring(roomDesc.SafeGridIndex), {
      shape: data.Shape,
      stageID: data.StageID,
      variant: data.Variant,
      subType: data.Subtype,
    });
  }

  const floorsMapIndex = `${recordingStage}.${recordingStageType}`;
  floorsMap.set(floorsMapIndex, roomsMap);
}

function moveToNextFloor() {
  if (incrementStageType()) {
    return;
  }

  if (VERBOSE) {
    Isaac.DebugString(
      `Going to stage: ${recordingStage}.${recordingStageType}`,
    );
  }
  goToStage(recordingStage, recordingStageType);
}

/** Returns true if we are restarting to the next seed. */
function incrementStageType() {
  recordingStageType += 1;

  // STAGETYPE_GREEDMODE is unused
  if (recordingStageType === StageType.STAGETYPE_GREEDMODE) {
    recordingStageType += 1;
  }

  if (recordingStageType > getMaxStageType(recordingStage)) {
    recordingStageType = StageType.STAGETYPE_ORIGINAL;
    return incrementStage();
  }

  return false;
}

function getMaxStageType(stage: int) {
  // There is alternate stage type for Corpse
  if (stage === 7 || stage === 8) {
    return StageType.STAGETYPE_REPENTANCE;
  }

  // There are zero variants of Blue Womb
  if (stage === 9) {
    return StageType.STAGETYPE_ORIGINAL;
  }

  // There is one variant of Sheol / The Dark Room
  if (stage === 10 || stage === 11) {
    return StageType.STAGETYPE_WOTL;
  }

  // There are zero variants of The Void
  if (stage === 12) {
    return StageType.STAGETYPE_ORIGINAL;
  }

  // There is one variant of Home
  if (stage === 13) {
    return StageType.STAGETYPE_WOTL;
  }

  return StageType.STAGETYPE_REPENTANCE_B;
}

/** Returns true if we are restarting to the next seed. */
function incrementStage() {
  recordingStage += 1;

  if (STAGES_TO_SKIP.has(recordingStage)) {
    recordingStage += 1;
  }

  if (recordingStage > FINAL_STAGE) {
    recordingStage = LevelStage.STAGE1_1;

    recordAllFloorsToSeedMap();
    restartOnNextFrame();
    return true;
  }

  return false;
}

function recordAllFloorsToSeedMap() {
  const startSeedString = getStartSeedString();

  seedsMap.set(startSeedString, floorsMap);
  seedsMapSize += 1;

  if (VERBOSE) {
    Isaac.DebugString(`Recorded seed: ${startSeedString}`);
    Isaac.DebugString(`Total seeds: ${seedsMapSize}`);
  }

  // Writing data to the disk is expensive, so only do it every N seeds
  if (seedsMapSize % NUMBER_OF_SEEDS_BEFORE_WRITING_TO_DISK === 0) {
    writeAllRecordedDataToSaveDatFile();
  }
}

function writeAllRecordedDataToSaveDatFile() {
  if (mod === null) {
    error("Mod was not initialized.");
  }

  const data = jsonEncode(seedsMap);
  mod.SaveData(data);

  if (VERBOSE) {
    Isaac.DebugString('Recorded data to the "save#.dat" file.');
  }
}

function restartOnNextFrame() {
  restart = true;
}
