import { pgTable, integer, varchar, timestamp, boolean } from "drizzle-orm/pg-core";

export const users = pgTable('users', {
  id: integer().primaryKey(),
  firstName: varchar('first_name', { length: 50 }).notNull(),
  lastName: varchar('last_name', { length: 50 }).notNull(),
  email: varchar('email', { length: 100 }).unique().notNull(),
  isActive: boolean('is_active').default(true),
  createdAt: timestamp('created_at').defaultNow()
});

export const posts = pgTable('posts', {
  id: integer().primaryKey(),
  title: varchar('title', { length: 200 }).notNull(),
  content: varchar('content', { length: 1000 }),
  authorId: integer('author_id').references(() => users.id),
  publishedAt: timestamp('published_at'),
  createdAt: timestamp('created_at').defaultNow()
});