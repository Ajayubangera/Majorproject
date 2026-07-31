# Surveillance and Verification Command Center

This is a full-stack surveillance project consisting of a React + Vite + TypeScript frontend and a FastAPI backend with integrated YOLOv8 object detection and Gemini AI verification.

## Project Structure

- **`/frontend`**: React with Vite and TypeScript.
- **`/backend`**: FastAPI application handling databases, WebSockets, YOLOv8 inference, and Gemini verification.
- **`package.json`**: Root package manager that allows launching both frontend and backend concurrently.

---

## Prerequisites

Before running the application, make sure you have the following installed on your machine:
- **Node.js** (v18 or higher)
- **Python** (v3.8 or higher)

---

## Installation & Setup

Follow these steps to set up the project locally:

### 1. Backend Setup
1. Open your terminal and navigate to the backend folder or work from the project root:
   ```bash
   cd backend
   ```
2. Create a Python virtual environment named `venv`:
   - **Windows**:
     ```bash
     python -m venv venv
     ```
   - **macOS/Linux**:
     ```bash
     python3 -m venv venv
     ```
3. Activate the virtual environment:
   - **Windows (Command Prompt)**:
     ```cmd
     venv\Scripts\activate.bat
     ```
   - **Windows (PowerShell)**:
     ```powershell
     .\venv\Scripts\Activate.ps1
     ```
   - **macOS/Linux**:
     ```bash
     source venv/bin/activate
     ```
4. Install the required Python dependencies:
   ```bash
   pip install -r requirements.txt
   ```
5. Set up your environment variables:
   - Copy `backend/.env.example` to `backend/.env`.
   - Update `backend/.env` with your Google Gemini API Key and database URL (or leave it blank to automatically fallback to SQLite).

---

### 2. Frontend Setup
From the project root directory, install the frontend dependencies by running:
```bash
npm run install-frontend
```

---

## Running the Application

You can run the application in two ways:

### Option A: Run Both Frontend & Backend Concurrently (Recommended)
From the project root directory, simply run:
```bash
npm start
```
This will automatically launch:
- **Backend API**: `http://localhost:8000`
- **Frontend App**: `http://localhost:5173`

### Option B: Run Backend and Frontend Separately
If you prefer to run them in separate terminal windows:

* **To run the Backend:**
  From the root directory:
  ```bash
  npm run backend
  ```
  *(Or activate your virtual environment in `/backend` and run `uvicorn main:app --reload`)*

* **To run the Frontend:**
  From the root directory:
  ```bash
  npm run dev
  ```
