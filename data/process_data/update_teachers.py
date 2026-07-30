'''
通过with_comment_index更新每位老师所教的课程信息
'''
import json


with open("./main/data/with_comment_index.json", "r", encoding="utf-8") as f:
    courses_data = json.load(f)["courses"]

def update_teachers(courses_data):
    tid = courses_data["tid"]
    sqid = courses_data["sqid"]
    count = courses_data["count"]
    avg = courses_data["avg"]
    with open(f"./main/data/teachers/{tid}.json", "r", encoding="utf-8") as f:
        teacher_data = json.load(f) # 读取对应老师文件
    for n in range(0, len(teacher_data["related_courses"])): # 遍历老师课程列表，找到对应课程
        teacher_course = teacher_data["related_courses"][n]
        # 取出并修改对应课程
        if teacher_course["id"] == sqid:
            new_teacher_course = teacher_data["related_courses"].pop(n)
            new_teacher_course["count"] = count
            new_teacher_course["avg"] = avg
            # 写回新数据
            teacher_data["related_courses"].append(new_teacher_course)
            # 保存修改后的数据
            with open(f"./main/data/teachers/{tid}.json", "w", encoding="utf-8") as f:
                json.dump(teacher_data, f)
            return
    print(f"教师数据缺失:\n    教师: {tid}\n    课程: {sqid}")

def main():
    for course_data in list(courses_data.values()):
        update_teachers(course_data)

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(f"Error: {e}")