# 🚆 TrainSheet-AI

AI-powered handwritten train sheet recognition for iPhone.

---

## 📖 Project Introduction

TrainSheet-AI is a Progressive Web App (PWA) designed to recognize handwritten train sheets from photos taken with an iPhone.

The goal is to replace manual data entry with automatic recognition.

---

## ✨ Features

- 📷 Take or select a photo
- 🎯 Automatically locate the target area
- 🚉 Recognize handwritten track numbers
- 🚆 Recognize handwritten train numbers
- 🕒 Match fixed timetable automatically
- 📄 Export to Excel
- ⚠️ Ask the user whenever recognition is uncertain
- 📱 Designed for iPhone PWA

---

## 📐 Recognition Rules

- Only recognize:
  - Track
  - Train Number

- Ignore:
  - 表号
  - 线号
  - Arrow (→)

Business Rules:

- A = 东
- C = 西
- East tracks: 01~20
- West tracks: 01~20
- Train numbers: 001~112
- Time comes from the fixed timetable.

---

## ❤️ Design Principle

> Never guess.

If the confidence is low,
the program must ask the user.

---

## 🚧 Current Status

Project planning...

Version 0.1
