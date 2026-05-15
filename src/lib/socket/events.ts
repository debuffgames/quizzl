export const QUIZ_EVENTS = {
  // Student → Server
  JOIN: "quiz:join",
  SUBMIT_ANSWER: "quiz:submitAnswer",

  // Teacher → Server
  NEXT_QUESTION: "quiz:nextQuestion",
  REVEAL_ANSWER: "quiz:revealAnswer",
  END_SESSION: "quiz:endSession",

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

  // Server → Teacher
  RESPONSE_COUNT: "quiz:responseCount",
  ANSWER_DIST: "quiz:answerDist",
  PLAYER_JOINED: "quiz:playerJoined",
  PLAYER_LEFT: "quiz:playerLeft",
} as const;
