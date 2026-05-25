export const QUIZ_EVENTS = {
  // Student → Server
  JOIN: "quiz:join",
  SUBMIT_ANSWER: "quiz:submitAnswer",
  AUTONOMOUS_COMPLETE: "quiz:autonomousComplete",  // AUTONOMOUS: student finished all questions

  // Teacher → Server
  NEXT_QUESTION: "quiz:nextQuestion",
  REVEAL_ANSWER: "quiz:revealAnswer",
  END_SESSION: "quiz:endSession",
  SHOW_ANSWERS: "quiz:showAnswers",                // BLITZ: reveal answer tiles, start countdown

  // Beamer → Server
  BEAMER_JOIN: "quiz:beamerJoin",

  // Server → Student
  SESSION_INFO: "quiz:sessionInfo",
  QUESTION: "quiz:question",
  TIMER_SYNC: "quiz:timerSync",
  ANSWER_REVEAL: "quiz:answerReveal",
  SCOREBOARD: "quiz:scoreboard",
  END: "quiz:end",
  PAUSE: "quiz:pause",
  RESUME: "quiz:resume",
  ANSWERS_VISIBLE: "quiz:answersVisible",          // BLITZ/SUPER_BLITZ: answers now shown, countdown starts
  TEAM_ASSIGNED: "quiz:teamAssigned",              // TEAM_SHIELD: which team student is on
  BOSS_STATE: "quiz:bossState",                    // BOSS: {hp, maxHp, timerEnd, ability, wrongCount, threshold}
  SHIELD_STATE: "quiz:shieldState",                // TEAM_SHIELD: {teams:[{name,hp,maxHp},…]}

  // Server → Teacher
  RESPONSE_COUNT: "quiz:responseCount",
  ANSWER_DIST: "quiz:answerDist",
  PLAYER_JOINED: "quiz:playerJoined",
  PLAYER_LEFT: "quiz:playerLeft",

  // Server → Beamer
  SESSION_STARTED: "quiz:sessionStarted",  // new session in same lobby — beamer should reset
} as const;

export type BossAbility =
  | "NONE"
  | "HIDDEN_ANSWER"
  | "HALF_TIME"
  | "MIRROR_TEXT"
  | "MOVING_BUTTONS"
  | "FLICKERING_BEAMER"
  | "DANCING_BUZZERS";
