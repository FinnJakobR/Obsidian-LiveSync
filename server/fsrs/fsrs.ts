import { Level } from "level";
import FreeSpacedRepetitionScheudler, { Card, numToGrade } from "./algo";
import Logger, { LogLevel } from "../util/logger";

export class Flashcard extends Card {
	private topic: string;
	private question: string;
	private answer: string;

	constructor(topic: string, question: string, answer: string) {
		super();
		this.topic = topic;
		this.question = question;
		this.answer = answer;
	}

	insertCard(card: Card) {
		this.difficulty = card.difficulty;
		this.due = card.due;
		this.elapsed_days = card.elapsed_days;
		this.last_review = card.last_review;
		this.learning_steps = card.learning_steps;
		this.mistakes = card.mistakes;
		this.reps = card.reps;
		this.scheudled_days = card.scheudled_days;
		this.stability = card.stability;
		this.state = card.state;
	}

	extractCard(): Card {
		const newCard = new Card();

		newCard.id = this.id;
		newCard.difficulty = this.difficulty;
		newCard.due = this.due;
		newCard.elapsed_days = this.elapsed_days;
		newCard.last_review = this.last_review;
		newCard.learning_steps = this.learning_steps;
		newCard.mistakes = this.mistakes;
		newCard.reps = this.reps;
		newCard.scheudled_days = this.scheudled_days;
		newCard.stability = this.stability;
		newCard.state = this.state;

		return newCard;
	}
}

export class LearningAI {
	private db_path: string;
	private connection: Level<string, Flashcard>;
	private logger: Logger;
	private algo: FreeSpacedRepetitionScheudler =
		new FreeSpacedRepetitionScheudler(
			false,
			0.93,
			36000,
			true,
			[10, 10],
			[10],
		);

	constructor(db_path: string, logger: Logger) {
		this.db_path = db_path;
		this.connection = new Level(this.db_path, { valueEncoding: "json" });
		this.logger = logger;
	}

	async addNewCard(topic: string, question: string, answer: string) {
		const newFlashCard = new Flashcard(topic, question, answer);
		await this.connection.put(newFlashCard.id, newFlashCard);

		this.logger.log({
			date: new Date(),
			level: LogLevel.INFO,
			message: `add new Card: ${topic}`,
			causing: "scheudle",
		});
	}

	async scheudleCard(id: string, g: number) {
		try {
			const raw = await this.connection.get(id);

			const flashcard = Object.assign(new Flashcard("", "", ""), raw);

			flashcard.due = new Date(flashcard.due);

			flashcard.last_review = flashcard.last_review
				? new Date(flashcard.last_review)
				: undefined;

			const grade = numToGrade(g);

			let card = flashcard.extractCard();
			const res = this.algo.next(card, new Date(), grade);
			card = res.card;
			flashcard.insertCard(card);

			this.logger.log({
				date: new Date(),
				level: LogLevel.DEBUG,
				message: `scheudle ${id} at ${card.due.toISOString()}`,
				causing: "scheudle",
			});

			await this.connection.put(id, flashcard);
		} catch (e) {
			this.logger.log({
				date: new Date(),
				level: LogLevel.ERROR,
				message: `Error occured at scheudle`,
				causing: "scheudle",
			});
			console.log(e);
			return 1;
		}

		return 0;
	}

	async getDailyCards() {
		const now = new Date();
		const result: Flashcard[] = [];

		for await (const [key, value] of this.connection.iterator()) {
			const due = new Date(value.due);
			if (now.getTime() >= due.getTime()) {
				result.push(value);
			}
		}

		return result;
	}
}
